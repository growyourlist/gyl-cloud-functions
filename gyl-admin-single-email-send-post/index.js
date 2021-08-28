const AWS = require('aws-sdk');
const Joi = require('joi');

const uuid = require('uuid');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const sendSingleEmailSchema = Joi.object({
	toEmailAddress: Joi.string().email().required(),
	templateId: Joi.string(),
	subject: Joi.when('templateId', {
		is: Joi.exist(),
		then: Joi.forbidden(),
		otherwise: Joi.string().allow('').required(),
	}),
	body: Joi.when('templateId', {
		is: Joi.exist(),
		then: Joi.forbidden(),
		otherwise: Joi.object({
			text: Joi.string().allow(''),
			html: Joi.string().allow(''),
		})
			.unknown(false)
			.or('body', 'html')
			.required(),
	}),
	opts: Joi.object({
		fromEmailAddress: Joi.string().allow(''),
		// Only allow scheduling up to a year in advance
		waitInSeconds: Joi.number().min(0).max(31708800),
		tagReason: Joi.alternatives(
			Joi.string()
				.regex(/^[\w-]+$/)
				.min(1)
				.max(128),
			Joi.array().items(
				Joi.string()
					.regex(/^[\w-]+$/)
					.min(1)
					.max(128)
			)
		),
		autoSaveUnknownSubscriber: Joi.boolean(),
		tagOnClick: Joi.string()
			.regex(/^[\w-]+$/)
			.max(128),
	}).unknown(false),
})
	.unknown(false)
	.required();

const badRequest = (message) => {
	return {
		statusCode: 400,
		headers: { 'Access-Control-Allow-Origin': '*' },
		body: JSON.stringify(message),
	};
};

/**
 * Creates a new queue item.
 */
const newQueueItem = (itemData, waitInSeconds) => {
	const runAt = Date.now() + waitInSeconds * 1000;
	const runAtModified = `${runAt}${Math.random().toString().substring(1)}`;
	return Object.assign({}, itemData, {
		queuePlacement: 'queued',
		runAtModified: runAtModified,
		runAt,
		attempts: 0,
		failed: false,
		completed: false,
	});
};

/**
 * Gets or creates the subscriber with the given email address.
 * @param {string} email
 */
const getOrCreateSubscriber = async (email, opts = {}) => {
	const statusResponse = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: { ':email': email.toLocaleLowerCase() },
		})
		.promise();
	const status = statusResponse.Count && statusResponse.Items[0];
	if (!status) {
		const subscriber = {
			subscriberId: uuid.v4(),
			email: email.toLocaleLowerCase(),
			displayEmail: email,
			confirmed: false,
			unsubscribed: false,
			joined: Date.now(),
			confirmationToken: uuid.v4(),
		};
		if (opts.autoSaveUnknownSubscriber) {
			await dynamodb
				.put({
					TableName: `${dbTablePrefix}Subscribers`,
					Item: subscriber,
				})
				.promise();
		}
		return subscriber;
	} else {
		const subscriberResponse = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Subscribers`,
				Key: { subscriberId: status.subscriberId },
			})
			.promise();
		if (!subscriberResponse.Item) {
			// The subscriber existed less than a second ago, but not anymore...
			const newId = uuid.v4();
			console.warn(
				'Creating subscriber after they existed a second ago. Old ' +
					`id: ${status.subscriberId} new id: ${newId}`
			);
			const subscriber = {
				subscriberId: newId,
				email: email.toLocaleLowerCase(),
				displayEmail: email,
				confirmed: false,
				unsubscribed: false,
				joined: Date.now(),
				confirmationToken: uuid.v4(),
			};
			if (opts.autoSaveUnknownSubscriber) {
				await dynamodb
					.put({
						TableName: `${dbTablePrefix}Subscribers`,
						Item: subscriber,
					})
					.promise();
			}
			return subscriber;
		}
		return subscriberResponse.Item;
	}
};

exports.handler = async (event) => {
	try {
		let requestBody = null;
		try {
			requestBody = await sendSingleEmailSchema.validateAsync(
				JSON.parse(event.body)
			);
		} catch (err) {
			return badRequest(err.message);
		}
		requestBody.opts = requestBody.opts || {};
		if (typeof requestBody.opts.tagReason === 'string') {
			requestBody.opts.tagReason = [requestBody.opts.tagReason];
		}
		const email = requestBody.toEmailAddress;

		// Silently suppress the email if the email address is from a blocked
		// domain.
		const blockedEmailDomainsSetting = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: {
				settingName: 'blockedEmailDomains'
			}
		}).promise()
		if (blockedEmailDomainsSetting.Item && Array.isArray(blockedEmailDomainsSetting.Item.value)) {
			const blockedDomains = new Set(blockedEmailDomainsSetting.Item.value);
			const lowercaseEmail = email.toLocaleLowerCase();
			const emailParts = lowercaseEmail.split('@');
			const domain = emailParts[emailParts.length - 1];
			if (domain && blockedDomains.has(domain)) {
				console.warn(`Suppressing email action because domain is on blocked domains list`);
				const response = {
					statusCode: 200,
					headers: { 'Access-Control-Allow-Origin': '*' },
					body: JSON.stringify('OK'),
				};
				return response;
			}
		}

		const subscriber = await getOrCreateSubscriber(email, requestBody.opts);
		const queueItemProps = {
			type: 'send email',
			subscriber,
			subscriberId: subscriber.subscriberId,
		};
		if (requestBody.templateId) {
			queueItemProps.templateId = requestBody.templateId;
		} else {
			queueItemProps.subject = requestBody.subject;
			queueItemProps.body = requestBody.body;
		}
		if (requestBody.opts.fromEmailAddress) {
			queueItemProps.sourceEmail = requestBody.opts.fromEmailAddress;
		}
		if (requestBody.opts.tagReason) {
			queueItemProps.tagReason = requestBody.opts.tagReason;
		}
		if (requestBody.opts.tagOnClick) {
			queueItemProps.tagOnClick = requestBody.opts.tagOnClick;
		}
		await dynamodb
			.put({
				TableName: `${dbTablePrefix}Queue`,
				Item: newQueueItem(queueItemProps, requestBody.opts.waitInSeconds || 0),
			})
			.promise();
		const response = {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify('OK'),
		};
		return response;
	} catch (err) {
		console.error(err);
		const response = {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(`Error: ${err.message}`),
		};
		return response;
	}
};
