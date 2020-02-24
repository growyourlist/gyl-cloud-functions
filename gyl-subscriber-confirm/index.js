const AWS = require('aws-sdk');
const moment = require('moment-timezone');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();
const uuidv4Pattern = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, message = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: message,
	};
};

/**
 * Based on the earliest given send data, user timezone and delivery preference,
 * return when the email should be sent.
 * @param  {Number} startSendAt When the email is scheduled to start sending.
 * @param  {String} timezone The timezone of the user.
 * @param  {Object} userDtp The user's delivery time preferences.
 * @return {Number} The time in milliseconds to attempt sending the email.
 */
const getRunAtTime = (startSendAt, timezone, userDtp) => {
	if (!timezone) {
		return startSendAt;
	}
	const dtp = userDtp || { hour: 9, minute: 30 };
	const sendAtTime = moment(startSendAt).tz(timezone);
	sendAtTime.hour(dtp.hour);
	sendAtTime.minute(dtp.minute);
	sendAtTime.second(0);
	return sendAtTime.valueOf();
};

/**
 * Gets a subscriber by their id.
 * @param  {String} subscriberId
 * @return {Promise<Object>}
 */
const getSubscriber = subscriberId =>
	dynamodb
		.get({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberId },
		})
		.promise();

/**
 * Creates a new queue item.
 */
const newQueueItem = (itemData, runAt = Date.now()) => {
	const realRunAt = getRunAtTime(
		runAt,
		itemData.subscriber.timezone,
		itemData.subscriber.deliveryTimePreference
	);
	const runAtModified = `${realRunAt}${Math.random()
		.toString()
		.substring(1)}`;
	return Object.assign({}, itemData, {
		queuePlacement: 'queued',
		runAtModified: runAtModified,
		runAt: realRunAt,
		attempts: 0,
		failed: false,
		completed: false,
	});
};

/**
 * Sets the confirmed status of a subscriber to true.
 * @param  {Object} subscriberData
 * @return {Promise}
 */
const confirmSubscriber = subscriberId =>
	dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberId },
			UpdateExpression:
				'set #confirmed = :true, #unsubscribed = :false, #confirmTimestamp = :timestamp',
			ExpressionAttributeNames: {
				'#confirmed': 'confirmed',
				'#unsubscribed': 'unsubscribed',
				'#confirmTimestamp': 'confirmTimestamp',
			},
			ExpressionAttributeValues: {
				':true': true,
				':false': false,
				':timestamp': Date.now(),
			},
		})
		.promise();

const constructQueueBatch = (autoresponders, subscriber) => {
	const batch = [];
	autoresponders.forEach(ar => {
		if (!ar.value.steps || !ar.value.steps.Start) {
			return;
		}
		const startStep = ar.value.steps.Start;
		if (startStep.type !== 'send email' || !startStep.templateId) {
			return;
		}
		batch.push({
			PutRequest: {
				Item: newQueueItem({
					type: startStep.type,
					subscriber: subscriber,
					subscriberId: subscriber.subscriberId,
					templateId: startStep.templateId,
					autoresponderId: ar.value.autoresponderId,
					autoresponderStep: 'Start',
				}),
			},
		});
	});
	return batch;
};

const runTriggeredAutoresponders = async subscriber => {
	const triggeredAutoresponders = await dynamodb
		.scan({
			TableName: `${dbTablePrefix}Settings`,
			FilterExpression:
				'begins_with(#settingName, :autoresponder) and ' +
				'#value.#trigger = :confirmed',
			ExpressionAttributeNames: {
				'#settingName': 'settingName',
				'#value': 'value',
				'#trigger': 'trigger',
			},
			ExpressionAttributeValues: {
				':autoresponder': 'autoresponder-',
				':confirmed': 'subscriber confirmed',
			},
		})
		.promise();
	if (!triggeredAutoresponders.Count) {
		return;
	}

	const batch = constructQueueBatch(triggeredAutoresponders.Items, subscriber);
	if (!batch.length > 0) {
		return;
	}

	await dynamodb
		.batchWrite({
			RequestItems: {
				[`${dbTablePrefix}Queue`]: batch,
			},
		})
		.promise();
};

exports.handler = async event => {
	try {
		const subscriberId = event.queryStringParameters['t'];
		if (uuidv4Pattern.test(subscriberId) !== true) {
			return response(400, JSON.stringify('Bad request'));
		}
		const result = await getSubscriber(subscriberId);
		if (!result || !result.Item) {
			return response(404, JSON.stringify('Not found'));
		}
		if (result.Item.confirmed === true && result.Item.unsubscribed === false) {
			return {
				statusCode: 307,
				headers: {
					'Access-Control-Allow-Origin': '*',
					Location: process.env.THANKYOU_URL,
				},
			};
		}

		await confirmSubscriber(subscriberId)
		await runTriggeredAutoresponders(result.Item)
		return {
			statusCode: 307,
			headers: {
				'Access-Control-Allow-Origin': '*',
				Location: process.env.THANKYOU_URL,
			},
		}
	} catch (err) {
		console.error(err);
		return response(500, 'Error');
	}
};
