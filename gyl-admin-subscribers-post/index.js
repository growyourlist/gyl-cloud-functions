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
		overwriteExisting: ExtJoi.boolean(),
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
		if (!opts.overwriteExisting) {
			throw new Error('overwriteExisting = false, subscribers must be ' +
				'overwritten in current implementation.');
		}

		const useDefaultConfirmedValue = typeof opts.defaultConfirmedValue !== 'undefined'
		await writeAllForDynamoDB(dynamodb, {
			RequestItems: {
				[`${dbTablePrefix}Subscribers`]: subscribers.map(subscriber => {

					let confirmed = true
					if (useDefaultConfirmedValue) {
						confirmed = opts.defaultConfirmedValue
					}
					if (typeof subscriber.confirmed !== 'undefined') {
						confirmed = subscriber.confirmed
					}

					const fullSubscriber = Object.assign({}, subscriber, {
						displayEmail: subscriber.email,
						email: subscriber.email.toLocaleLowerCase(),
						subscriberId: uuidv4(),
						confirmed,
						unsubscribed: subscriber.unsubscribed || opts.defaultUnsubscribedValue || false,
						joined: subscriber.joined || Date.now(),
						confirmationToken: uuidv4(),
					});
					return {
						PutRequest: {
							Item: fullSubscriber
						}
					}
				})
			}
		})
		return response(200, 'OK');
	} catch (err) {
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
