const AWS = require('aws-sdk');
const Joi = require('joi');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate the request to add a tag.
const addTagSchema = Joi.object({
	email: Joi.string().lowercase().email().required(),
	tag: Joi.string()
		.regex(/^[\w-]+$/)
		.min(1)
		.max(64)
		.required(),
});

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
			'Content-Type': 'text/plain; charset=utf-8',
		},
		body: body,
	};
};

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberByEmail = async (email) => {
	const subscriberResponse = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise();
	if (!subscriberResponse.Count || !subscriberResponse.Items[0]) {
		const error = new Error('Subscriber not found');
		error.statusCode = 404;
		throw error;
	}
	const subscriber = subscriberResponse.Items[0];
	return subscriber;
};

const getSubscriberFull = (subscriberId) =>
	dynamodb
		.get({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId },
		})
		.promise()
		.then((result) => {
			if (!result.Item) {
				return null;
			}
			return result.Item;
		});

/**
 * Adds a tag to the subscriber with the given email address.
 */
const addTag = async (subscriberStatus, tag) => {
	const currentTags = subscriberStatus.tags || [];
	const currentIndex = currentTags.indexOf(tag);
	if (currentIndex >= 0) {
		// Tag already exists, can return
		return;
	}

	const newTags = currentTags.concat([tag]);
	return dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberStatus.subscriberId },
			UpdateExpression: 'set #tags = :tags',
			ExpressionAttributeNames: { '#tags': 'tags' },
			ExpressionAttributeValues: { ':tags': newTags },
		})
		.promise();
};

// Schema to validate triggers
const paramsSchema = Joi.object({
	triggerType: Joi.string().valid('autoresponder'),
	triggerId: Joi.when('triggerType', {
		is: 'autoresponder',
		then: Joi.string()
			.pattern(/^[a-zA-Z0-9]+$/)
			.required(),
		otherwise: Joi.forbidden(),
	}),
}).unknown(false);

/**
 * Runs a trigger given the
 * @param {object} params
 * @param {object} subscriber
 */
const runTrigger = async (params, subscriber) => {
	if (params.triggerType === 'autoresponder' && params.triggerId) {
		// Run an autoresponder trigger.
		const autoresponderId = params.triggerId;
		const autoResponderResponse = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Settings`,
				Key: {
					settingName: `autoresponder-${autoresponderId}`,
				},
			})
			.promise();
		const startStep =
			autoResponderResponse &&
			autoResponderResponse.Item &&
			autoResponderResponse.Item.value &&
			autoResponderResponse.Item.value.steps &&
			autoResponderResponse.Item.value.steps.Start;
		if (!startStep) {
			console.warn(
				'Autoresponder or autoresponder start step not found ' +
					`autoresponder-${autoresponderId}:Start`
			);
			return;
		}
		const runAt = Date.now();
		const runAtModified = `${runAt}${Math.random().toString().substring(1)}`;
		const queueItem = Object.assign({}, startStep, {
			queuePlacement: 'queued',
			runAtModified,
			runAt,
			attempts: 0,
			failed: false,
			completed: false,
			subscriber,
			subscriberId: subscriber.subscriberId,
			autoresponderId,
			autoresponderStep: 'Start',
		});
		await dynamodb
			.put({
				TableName: `${dbTablePrefix}Queue`,
				Item: queueItem,
			})
			.promise();
	}
};

exports.handler = async (event) => {
	try {
		const addTagRequest = JSON.parse(event.body);
		const addTagData = await addTagSchema.validateAsync(addTagRequest);
		const subscriberStatus = await getSubscriberByEmail(addTagData.email);
		await addTag(subscriberStatus, addTagData.tag);
		try {
			const params =
				event.queryStringParameters &&
				(await paramsSchema.validateAsync(event.queryStringParameters));
			if (params) {
				const subscriberFull = await getSubscriberFull(
					subscriberStatus.subscriberId
				);
				if (subscriberFull) {
					await runTrigger(params, subscriberFull);
				}
			}
		} catch (err) {
			console.error(err);
		}
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(err.statusCode || 500, err.message || 'Error');
	}
};
