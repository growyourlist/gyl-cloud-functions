const AWS = require('aws-sdk');
const Joi = require('joi');
const uuid = require('uuid');
const moment = require('moment-timezone');

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
}).unknown(false);

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
	const now = Date.now();
	const fullSubscriber = Object.assign({}, subscriberData, {
		subscriberId: uuid.v4(),
		confirmed: false,
		unsubscribed: false,
		joined: now,
		lastConfirmation: now,
		confirmationToken: uuid.v4(),
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
 * @param  {Object} subscriberData
 * @param  {String} templateId
 * @return {Promise}
 */
const sendConfirmationEmail = async (subscriberData) => {
	const confirmLink = `${process.env.PUBLIC_API}/subscriber/confirm?t=${subscriberData.subscriberId}`;
	const toAddress = subscriberData.displayEmail || subscriberData.email;
	await ses
		.sendEmail({
			Destination: {
				ToAddresses: [toAddress],
			},
			ConfigurationSetName: 'GylSesConfigurationSet',
			Source: process.env.SOURCE_EMAIL,
			Message: {
				Subject: {
					Charset: 'UTF-8',
					Data: 'Confirm your subscription',
				},
				Body: {
					Html: {
						Charset: 'UTF-8',
						Data: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Confirmation</title>
</head>
<body>
	<p>Please confirm your subscription to this mailing list by clicking the link:</p>
	<p><a href="${confirmLink}" rel="noreferrer noopener">Confirm subscription</a></p>
</body>
</html>`,
					},
					Text: {
						Charset: 'UTF-8',
						Data: `
Please confirm your subscription to this mailing list by clicking the link:
${confirmLink}
`,
					},
				},
			},
		})
		.promise();
};

const updateLastConfirmation = (subscriber) =>
	dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			ConditionExpression: 'attribute_exists(#subscriberId)',
			UpdateExpression: 'set #lastConfirmation = :lastConfirmation',
			ExpressionAttributeNames: {
				'#subscriberId': 'subscriberId',
				'#lastConfirmation': 'lastConfirmation',
			},
			ExpressionAttributeValues: {
				':lastConfirmation': Date.now(),
			},
			Key: { subscriberId: subscriber.subscriberId },
		})
		.promise();

/**
 * Posts a subscriber and runs a confirmation or autoresponder trigger if
 * provided.
 */
exports.handler = async (event) => {
	try {
		const subscriberInput = await addSubscriberSchema.validateAsync(
			JSON.parse(event.body)
		);
		const { email } = subscriberInput;

		// Silently suppress the creation if the email address is from a blocked
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
				return response(200, JSON.stringify('OK'))
			}
		}

		const existingSubscriber = await getSubscriberIdByEmail(email);
		if (!existingSubscriber) {
			subscriberInput.displayEmail = email;
			subscriberInput.tags = [];
			if (
				process.env.DEFAULT_LIST
			) {
				subscriberInput.tags.push(process.env.DEFAULT_LIST);
			}
			subscriberInput.email = email.toLocaleLowerCase();
			const fullSubscriber = await saveSubscriber(subscriberInput);
			await sendConfirmationEmail(fullSubscriber);
			return response(200, JSON.stringify('OK'));
		} else {
			const fullSubscriber = await getSubscriberFull(
				existingSubscriber.subscriberId
			);
			if (!fullSubscriber) {
				// They were there just a second ago, but disappeared since.
				return response(500, JSON.stringify('Server error'));
			}
			// Resend the confirmation if the subscriber is unsubscribed
			if (fullSubscriber.unsubscribed) {
				await sendConfirmationEmail(fullSubscriber);
				await updateLastConfirmation(fullSubscriber);
			}
			if (!fullSubscriber.confirmed) {
				// Resend confirmation if there's no record of the last confirmation
				if (!fullSubscriber.lastConfirmation) {
					await sendConfirmationEmail(fullSubscriber);
					await updateLastConfirmation(fullSubscriber);
				} else {
					// Resend confirmation if the last confirmation was over 3 hours ago
					if (fullSubscriber.lastConfirmation < Date.now() - 10800000) {
						await sendConfirmationEmail(fullSubscriber);
						await updateLastConfirmation(fullSubscriber);
					}
				}
			}
			return response(200, JSON.stringify('OK'));
		}
	} catch (err) {
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
