const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const uuidv4 = require('uuid/v4');
const moment = require('moment-timezone');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb')


const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();

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
const addSubscribersSchema = ExtJoi.object({
	opts: ExtJoi.object({
		skipDuplicateCheck: ExtJoi.boolean(),
		defaultUnsubscribedValue: ExtJoi.boolean(),
		defaultConfirmedValue: ExtJoi.boolean(),
	}).required(),
	subscribers: ExtJoi.array().items(
		ExtJoi.object({
			email: ExtJoi.string()
				.email()
				.required(),
			timezone: ExtJoi.timezone(),
			joined: ExtJoi.number(),
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
		}).unknown(true).without(
			'email', ['displayEmail', 'confirmationToken', 'subscriberId']
		)
	).min(1).max(25).required(),
});

const response = (statusCode, body = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
	};
};

/**
 * Posts a batch of subscribers
 */
exports.handler = async event => {
	try {
		const input = await addSubscribersSchema.validateAsync(
			JSON.parse(event.body)
		);
		const { opts, subscribers } = input;
		let finalSubscribers = null;
		if (!opts.skipDuplicateCheck) {
			const uniqueSubscribers = [];
			const subscriberEmails = new Set();
			subscribers.forEach(subscriber => {
				const lowerCaseEmail = subscriber.email.toLocaleLowerCase();
				if (!subscriberEmails.has(lowerCaseEmail)) {
					subscriberEmails.add(lowerCaseEmail);
					uniqueSubscribers.push(subscriber);
				}
			});

			const currentSubscribers = await Promise.all(
				uniqueSubscribers.map(async subscriber => {
					const response = await dynamodb.query({
						TableName: `${dbTablePrefix}Subscribers`,
						IndexName: 'EmailToStatusIndex',
						KeyConditionExpression: '#email = :email',
						ExpressionAttributeNames: { '#email': 'email' },
						ExpressionAttributeValues: { ':email': subscriber.email },
					}).promise();
					if (response.Count) {
						return response.Items[0];
					}
					return null;
				})
			);

			const currentSubscriberEmails = new Set();
			currentSubscribers
				.filter(subscriber => !!subscriber)
				.forEach(subscriber => {
					currentSubscriberEmails.add(subscriber.email.toLocaleLowerCase())
				})

			const subscribersToAdd = [];
			uniqueSubscribers.forEach(subscriber => {
				if (!currentSubscriberEmails.has(subscriber.email.toLocaleLowerCase())) {
					subscribersToAdd.push(subscriber);
				}
			});
			finalSubscribers = subscribersToAdd;
		} else {
			finalSubscribers = subscribers;
		}

		if (!finalSubscribers.length) {
			// All subscribers are already in the db
			return response(200, 'OK')
		}

		const useDefaultConfirmedValue = typeof opts.defaultConfirmedValue !== 'undefined'
		const useDefaultUnsubscribedValue = typeof opts.defaultUnsubscribedValue !== 'undefined'
		await writeAllForDynamoDB(dynamodb, {
			RequestItems: {
				[`${dbTablePrefix}Subscribers`]: finalSubscribers.map(subscriber => {

					let confirmed = true
					if (useDefaultConfirmedValue) {
						confirmed = opts.defaultConfirmedValue
					}
					if (typeof subscriber.confirmed !== 'undefined') {
						confirmed = subscriber.confirmed
					}
					
					let unsubscribed = false;
					if (useDefaultUnsubscribedValue) {
						unsubscribed = opts.defaultUnsubscribedValue
					}
					if (typeof subscriber.unsubscribed !== 'undefined') {
						unsubscribed = subscriber.unsubscribed
					}

					const fullSubscriber = Object.assign({}, subscriber, {
						displayEmail: subscriber.email,
						email: subscriber.email.toLocaleLowerCase(),
						subscriberId: uuidv4(),
						confirmed,
						unsubscribed,
						joined: subscriber.joined || Date.now(),
						confirmationToken: uuidv4(),
					});
					return {
						PutRequest: {
							Item: fullSubscriber,
						}
					}
				})
			}
		})
		return response(200, 'OK');
	} catch (err) {
		console.error(err)
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
