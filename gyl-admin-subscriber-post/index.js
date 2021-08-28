const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { queryAllForDynamoDB } = require('query-all-for-dynamodb');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES();

// Extend Joi to include timezone validation.
const minDate = new Date();
minDate.setFullYear(minDate.getFullYear() - 130);
const ExtJoi = Joi.extend((joi) => ({
	type: 'timezone',
	base: joi.string(),
	messages: {
		'timezone.base': '"{{#label}}" must be a valid timezone',
	},
	validate(value, helpers) {
		if (!moment.tz.zone(value)) {
			return { value, errors: helpers.error('timezone.base') };
		}
	},
}));

// Schema to validate incoming add subscriber requests from userland.
const addSubscriberSchema = ExtJoi.object({
	email: ExtJoi.string().email().required(),
	timezone: ExtJoi.timezone(),
	deliveryTimePreference: ExtJoi.object({
		hour: ExtJoi.number().integer().min(0).max(23).required(),
		minute: ExtJoi.number().integer().min(0).max(59).required(),
	}),
	tags: ExtJoi.array()
		.allow(null)
		.min(0)
		.max(50)
		.items(ExtJoi.string().min(1).max(64)),
	confirmed: ExtJoi.alternatives().try(
		ExtJoi.boolean(),
		ExtJoi.number(),
		ExtJoi.string()
	),
	unsubscribed: ExtJoi.alternatives().try(
		ExtJoi.boolean(),
		ExtJoi.number(),
		ExtJoi.string()
	),
}).unknown(true);

// Schema to validate triggers
const triggerSchema = Joi.object({
	triggerType: Joi.string().valid('confirmation', 'autoresponder'),
	triggerId: Joi.when('triggerType', {
		'switch': [
			{
				is: 'autoresponder',
				then: Joi.string()
					.pattern(/^[a-zA-Z0-9]+$/)
					.required(),
			},
			{
				is: 'confirmation',
				then: Joi.string()
					.pattern(/^[a-zA-Z0-9]+$/)
					.required(),
				otherwise: Joi.forbidden(),
			},
		],
	}),
	// triggerAutoresponders is not handled as a result of this schema, it is
	// handled by the schema matching array parameters
	triggerAutoresponders: Joi.any(),
}).unknown(false);

const optsSchema = Joi.object({
	// triggerType is not handled as a result of this schema, it is
	// handled by the schema matching non-array parameters
	triggerType: Joi.any(),
	// triggerId is not handled as a result of this schema, it is
	// handled by the schema matching non-array parameters
	triggerId: Joi.any(),
	triggerAutoresponders: Joi.array().items(
		Joi.string().pattern(/^[a-zA-Z0-9]+$/)
	).optional()
})

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberIdByEmail = (email) =>
	dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email.toLocaleLowerCase(),
			},
		})
		.promise()
		.then((results) => {
			if (!results.Count) {
				return null;
			}
			return results.Items[0];
		});

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
 * Saves subscriber data to the database.
 * @param  {Object} subscriberData
 * @return {Promise}
 */
const saveSubscriber = async (subscriberData) => {
	const fullSubscriber = Object.assign(
		{},
		{
			confirmed: false,
			unsubscribed: false,
		},
		subscriberData,
		{
			joined: Date.now(),
			subscriberId: uuid.v4(),
			confirmationToken: uuid.v4(),
		}
	);
	await dynamodb
		.put({
			TableName: `${dbTablePrefix}Subscribers`,
			Item: fullSubscriber,
			KeyConditionExpression: 'attribute_not_exists(subscriberId)',
		})
		.promise();
	return fullSubscriber;
};

/**
 * Sends confirmation email to the subscriber.
 * @param  {Object} subscriberData
 * @param  {String} templateId
 * @return {Promise}
 */
const sendConfirmationEmail = async (subscriberData, templateId = null) => {
	const confirmLink = `${process.env.API}subscriber/confirm/?t=`;
	const realTemplateId = templateId || 'Confirmation';
	const templateParams = {
		Destination: {
			ToAddresses: [subscriberData.displayEmail || subscriberData.email],
		},
		ConfigurationSetName: 'GylSesConfigurationSet',
		Source: process.env.SOURCE_EMAIL,
		Template: realTemplateId,
		TemplateData: JSON.stringify({
			subscriber: subscriberData,
			confirmationLink: `${confirmLink}${subscriberData.subscriberId}`,
		}),
		Tags: [
			{
				Name: 'TemplateId',
				Value: realTemplateId,
			},
		],
	};
	await ses.sendTemplatedEmail(templateParams).promise();
};

/**
 * Checks if all tags in tagsA are present in tagsB
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 */
const checkHasAllTags = (tagsA, tagsB) => {
	if (!Array.isArray(tagsB) || !tagsB.length) {
		return true; // because tagsB has no tags, therefore tagsA needs no tags to
		// fulfill all the tags of tagsB
	}
	if (!Array.isArray(tagsA) || !tagsA.length) {
		return false; // because tagsB is an array with items and this point and
		// tagsA is not.
	}
	for (let i = 0; i < tagsB.length; i++) {
		if (tagsA.indexOf(tagsB[i]) < 0) {
			return false;
		}
	}
	return true;
};

/**
 * Merges newTags into currentTags, returning a new array.
 * @param {string[]} currentTags
 * @param {string[]} newTags
 */
const mergeTags = (currentTags, newTags) => {
	const mergedTags = (currentTags || []).slice();
	const realNewTags = newTags || [];
	realNewTags.forEach((tag) => {
		if (mergedTags.indexOf(tag) < 0) {
			mergedTags.push(tag);
		}
	});
	return mergedTags;
};

async function triggerAutoresponders(opts, subscriber) {
	if (!opts || !Array.isArray(opts.triggerAutoresponders)) {
		return;
	}
	for (const autoresponderId of opts.triggerAutoresponders) {
		await addSubscriberToAutoresponder(autoresponderId, subscriber);
	}
}

/**
 * Runs a trigger given the
 * @param {object} params
 * @param {object} subscriber
 */
const runTrigger = async (params, subscriber) => {
	if (!params) {
		// No trigger found, nothing to do.
		return;
	}
	if (params && params.triggerType === 'confirmation') {
		// Run a send confirmation email trigger.
		return await sendConfirmationEmail(
			subscriber,
			(params && params.triggerId) || null
		);
	} else if (
		params &&
		params.triggerType === 'autoresponder' &&
		params.triggerId
	) {
		await addSubscriberToAutoresponder(params.triggerId, subscriber);
	}
};

async function addSubscriberToAutoresponder(autoresponderId, subscriber) {
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

/**
 * Posts a subscriber and runs a confirmation or autoresponder trigger if
 * provided.
 */
exports.handler = async (event) => {
	try {
		const subscriberInput = await addSubscriberSchema.validateAsync(
			JSON.parse(event.body)
		);
		const trigger =
			event.queryStringParameters &&
			(await triggerSchema.validateAsync(event.queryStringParameters));
		const opts = event.multiValueQueryStringParameters &&
			(await optsSchema.validateAsync(event.multiValueQueryStringParameters));
		const { email } = subscriberInput;
		const existingSubscriber = await getSubscriberIdByEmail(
			email.toLocaleLowerCase()
		);

		// Silently suppress the creation if the email address is from a blocked
		// domain.
		const blockedEmailDomainsSetting = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: {
				settingName: 'blockedEmailDomains'
			}
		}).promise()
		if (blockedEmailDomainsSetting.Item) {
			const blockedDomains = new Set(blockedEmailDomainsSetting.Item.value);
			const lowercaseEmail = email.toLocaleLowerCase();
			const emailParts = lowercaseEmail.split('@');
			const domain = emailParts[emailParts.length - 1];
			if (domain && blockedDomains.has(domain)) {
				console.warn(`Suppressing email action because domain is on blocked domains list`);
				return response(200, JSON.stringify('Added'))
			}
		}

		if (!existingSubscriber) {
			subscriberInput.displayEmail = email;
			subscriberInput.email = email.toLocaleLowerCase();
			const fullSubscriber = await saveSubscriber(subscriberInput);
			await runTrigger(trigger, fullSubscriber);
			await triggerAutoresponders(opts, fullSubscriber);
			return response(200, JSON.stringify('Added'));
		} else {
			const fullSubscriber = await getSubscriberFull(
				existingSubscriber.subscriberId
			);
			let hasAllTags = checkHasAllTags(
				fullSubscriber.tags,
				subscriberInput.tags
			);
			const tagsUpdate = hasAllTags
				? existingSubscriber.tags
				: mergeTags(fullSubscriber.tags, subscriberInput.tags);
			const updatedSubscriber = Object.assign(
				{},
				fullSubscriber,
				subscriberInput,
				{
					tags: tagsUpdate,
					email: email.toLocaleLowerCase(),
				}
			);
			if (existingSubscriber.unsubscribed) {
				updatedSubscriber.unsubscribed = false;
				updatedSubscriber.tags = subscriberInput.tags;
				if (typeof subscriberInput.confirmed === 'undefined') {
					updatedSubscriber.confirmed = false;
				}
			}
			// If the existing subscriber was already confirmed and the update
			// details also instruct that the subscriber should be confirmed,
			// then retain the existing confirmed value
			if (existingSubscriber.confirmed && subscriberInput.confirmed) {
				updatedSubscriber.confirmed = existingSubscriber.confirmed;
			}
			await dynamodb
				.put({
					TableName: `${dbTablePrefix}Subscribers`,
					Item: updatedSubscriber,
				})
				.promise();
			if (!hasAllTags) {
				await runTrigger(event.queryStringParameters, updatedSubscriber);
				await triggerAutoresponders(opts, updatedSubscriber);
			}
			const queueInfoResponse = await queryAllForDynamoDB(dynamodb, {
				TableName: `${dbTablePrefix}Queue`,
				IndexName: 'SubscriberIdIndex',
				KeyConditionExpression: '#subscriberId = :subscriberId',
				FilterExpression: '#queuePlacement = :queued',
				ExpressionAttributeNames: {
					'#subscriberId': 'subscriberId',
					'#queuePlacement': 'queuePlacement',
				},
				ExpressionAttributeValues: {
					':subscriberId': updatedSubscriber.subscriberId,
					':queued': 'queued',
				},
			});
			const queueInfoItems = queueInfoResponse.Count && queueInfoResponse.Items;
			if (Array.isArray(queueInfoItems) && queueInfoItems.length) {
				const queueResponse = await dynamodb
					.batchGet({
						RequestItems: {
							[`${dbTablePrefix}Queue`]: {
								Keys: queueInfoItems.slice(0, 100).map((item) => ({
									queuePlacement: item.queuePlacement,
									runAtModified: item.runAtModified,
								})),
							},
						},
					})
					.promise();
				const queueItems = queueResponse.Count && queueResponse.Items;
				if (Array.isArray(queueItems) && queueItems.length) {
					await writeAllForDynamoDB(dynamodb, {
						RequestItems: {
							[`${dbTablePrefix}Queue`]: queueItems.map((item) => ({
								PutRequest: {
									Item: Object.assign({}, item, {
										subscriber: updatedSubscriber,
									}),
								},
							})),
						},
					});
				}
			}
			return response(200, JSON.stringify('Updated'));
		}
	} catch (err) {
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
