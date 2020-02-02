const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const uuidv4 = require('uuid/v4');
const moment = require('moment-timezone');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES();

// Extend Joi to include timezone validation.
const minDate = new Date();
minDate.setFullYear(minDate.getFullYear() - 130);
const ExtJoi = Joi.extend(joi => ({
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
	email: ExtJoi.string()
		.lowercase()
		.email()
		.required(),
	timezone: ExtJoi.timezone(),
	deliveryTimePreference: ExtJoi.object({
		hour: ExtJoi.number()
			.integer()
			.min(0)
			.max(23)
			.required(),
		minute: ExtJoi.number()
			.integer()
			.min(0)
			.max(59)
			.required(),
	}),
	tags: ExtJoi.array()
		.allow(null)
		.min(0)
		.max(50)
		.items(
			ExtJoi.string()
				.min(1)
				.max(64)
		),
}).unknown(true);

// Schema to validate triggers
const triggerSchema = Joi.allow(null, undefined)
	.object({
		triggerType: Joi.valid('confirmation', 'autoresponder'),
		triggerId: Joi.when('triggerType', {
			is: 'autoresponder',
			then: Joi.string()
				.pattern(/^[a-zA-Z0-9]+$/)
				.required(),
			otherwise: Joi.forbidden(),
		}),
	})
	.unknown(false);

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberIdByEmail = email =>
	dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise()
		.then(results => {
			if (!results.Count) {
				return null;
			}
			return results.Items[0];
		});

const getSubscriberFull = subscriberId =>
	dynamodb
		.get({
			TableName: 'Subscribers',
			Key: { subscriberId },
		})
		.promise()
		.then(result => {
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
const saveSubscriber = async subscriberData => {
	const fullSubscriber = Object.assign({}, subscriberData, {
		subscriberId: uuidv4(),
		confirmed: false,
		unsubscribed: false,
		joined: Date.now(),
		confirmationToken: uuidv4(),
	});
	await dynamodb
		.put({
			TableName: `${dbTablePrefix}Subscribers`,
			Item: fullSubscriber,
		})
		.promise();
	return fullSubscriber;
};

/**
 * Sends confirmation email to the subscriber.
 * @param  {String} subscriberId
 * @param  {String} email
 * @return {Promise}
 */
const sendConfirmationEmail = async (subscriberData, templateId = null) => {
	const confirmLink = `${process.env.API}subscriber/confirm/?t=`;
	const realTemplateId = templateId || 'Confirmation';
	const templateParams = {
		Destination: { ToAddresses: [subscriberData.email] },
		ConfigurationSetName: 'Default',
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
	realNewTags.forEach(tag => {
		if (mergedTags.indexOf(tag) < 0) {
			mergedTags.push(tag);
		}
	});
	return realNewTags;
};

/**
 * Runs a trigger given the 
 * @param {object} params 
 * @param {object} subscriber 
 */
const runTrigger = async (params, subscriber) => {
	if (!params) {
		// No trigger found, nothing to do.
		return
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

/**
 * Posts a subscriber and runs a confirmation or autoresponder trigger if
 * provided.
 */
exports.handler = async event => {
	try {
		const subscriberInput = await addSubscriberSchema.validateAsyc(
			JSON.parse(event.body)
		);
		const trigger = await triggerSchema.validateAsyc(
			event.queryStringParameters
		);
		const { email } = subscriberInput;
		const existingSubscriber = await getSubscriberIdByEmail(email);
		if (!existingSubscriber) {
			const fullSubscriber = await saveSubscriber(subscriberInput);
			await runTrigger(trigger, fullSubscriber);
			return response(200, JSON.stringify('Added'));
		} else {
			const fullSubscriber = getSubscriberFull(existingSubscriber.subscriberId);
			let hasAllTags = checkHasAllTags(
				fullSubscriber.tags,
				subscriberInput.tags
			);
			if (!hasAllTags) {
				fullSubscriber.tags = mergeTags(
					fullSubscriber.tags,
					subscriberInput.tags
				);
			}
			const updatedSubscriber = Object.assign(
				{},
				fullSubscriber,
				subscriberInput
			);
			await dynamodb
				.put({
					TableName: 'Subscribers',
					Item: fullSubscriber,
				})
				.promise();
			if (!hasAllTags) {
				await runTrigger(event.queryStringParameters, updatedSubscriber);
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
