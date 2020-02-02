const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate subscriber info.
const subscriberSchema = Joi.object({
	email: Joi.string()
		.email()
		.required(),
	subscriberId: Joi.string().guid(),
}).or('email', 'subscriberId');

// Schema to validate trigger info.
const triggerSchema = Joi.object({
	triggerType: Joi.string()
		.valid('autoresponder')
		.required(),
	triggerId: Joi.string()
		.pattern(/[a-zA-Z0-9]+/)
		.required(),
	triggerStep: Joi.string()
		.pattern(/[a-zA-Z0-9]+/)
		.optional(),
});

/**
 * Fetches a subscriber associated with the given email or id.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getFullSubscriber = async subscriberData => {
	if (subscriberData.subscriberId) {
		const response = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Subscribers`,
				Key: { subscriberId: subscriberData.subscriberId },
			})
			.promise();
		if (!response.Item) {
			const err = new Error('Subscriber not found');
			err.statusCode = 400;
			throw err;
		}
		return response.Item;
	}
	const response = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': subscriberData.email,
			},
		})
		.promise();
	if (
		!response.Count ||
		!response.Items[0] ||
		!response.Items[0].subscriberId
	) {
		const err = new Error('Subscriber not found');
		err.statusCode = 400;
		throw err;
	}
	return await getFullSubscriber(response.Items[0]);
};

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, body = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json; charset=utf-8',
		},
		body,
	};
};

/**
 * Runs the given trigger using the given subscriber details.
 * @param {object} trigger
 * @param {object} subscriber
 */
const runTrigger = async (trigger, subscriber) => {
	const autoresponderResponse = await dynamodb
		.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: `autoresponder-${trigger.triggerId}` },
		})
		.promise();
	if (typeof autoresponderResponse.Item !== 'object') {
		const err = new Error('Autoresponder not found');
		err.statusCode = 400;
		throw err;
	}
	const autoresponder = autoresponderResponse.Item;
	const stepName = trigger.triggerStep || 'Start';
	const startStep =
		autoresponder &&
		autoresponder.value &&
		autoresponder.value.steps &&
		autoresponder.value.steps[stepName];
	if (typeof startStep !== 'object') {
		const err = new Error('Autoresponder not found');
		err.statusCode = 400;
		throw err;
	}
	const runAt = Date.now();
	const runAtModified = `${runAt}${Math.random()
		.toString()
		.substring(1)}`;
	const queueItem = Object.assign({}, startStep, {
		queuePlacement: 'queued',
		runAtModified,
		runAt,
		attempts: 0,
		failed: false,
		completed: false,
		subscriber,
		subscriberId: subscriber.subscriberId,
		autoresponderId: autoresponder.autoresponderId,
		autoresponderStep: stepName,
	});
	return await dynamodb
		.put({
			TableName: `${dbTablePrefix}Queue`,
			Item: queueItem,
		})
		.promise();
};

exports.handler = async event => {
	try {
		const subscriberInfo = await subscriberSchema.validateAsync(
			JSON.parse(event.body)
		);
		const subscriber = await getFullSubscriber(subscriberInfo);
		const trigger = await triggerSchema.validateAsync(
			event.queryStringParameters
		);
		await runTrigger(trigger, subscriber);
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(err.statusCode || 500, JSON.stringify(err.message));
	}
};
