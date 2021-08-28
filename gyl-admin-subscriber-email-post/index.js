const Joi = require('joi');
const AWS = require('aws-sdk');
const { default: PQueue } = require('p-queue');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { queryAllForDynamoDB, ReturnType } = require('query-all-for-dynamodb');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const updateEmailSchema = Joi.object({
	subscriberId: Joi.string().lowercase().uuid().required(),
	email: Joi.string().email().required(),
}).required();

exports.handler = async (event) => {
	try {
		const { subscriberId, email } = await updateEmailSchema.validateAsync(JSON.parse(event.body));
		const currentSubscriberResponse = await dynamodb.get({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId },
		}).promise()

		// Updating the email for an existing subscriber only works if an existing subscriber can be
		// found.
		if (!currentSubscriberResponse.Item) {
			const error = new Error('Subscriber not found')
			error.statusCode = 404
			throw error;
		}
		const currentSubscriber = currentSubscriberResponse.Item
		const newEmailLowerCase = email.toLocaleLowerCase();

		// Silently suppress the email update if the new email is from a blocked
		// domain.
		const blockedEmailDomainsSetting = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: {
				settingName: 'blockedEmailDomains'
			}
		}).promise()
		if (blockedEmailDomainsSetting.Item && Array.isArray(blockedEmailDomainsSetting.Item.value)) {
			const blockedDomains = new Set(blockedEmailDomainsSetting.Item.value);
			const emailParts = newEmailLowerCase.split('@');
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

		// No need to update the email if the current email is already the same.
		if (newEmailLowerCase === currentSubscriber.email) {
			return {
				statusCode: 200,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Content-Type': 'application/json; charset=utf-8',
				},
				body: JSON.stringify('OK'),
			}
		}

		// At this point, we have a current subscriber, and a new email to set on this subscriber; so,
		// we can update them.
		const newDisplayEmail = (newEmailLowerCase === email) ? '' : email;
		await dynamodb.update({
			TableName: `${dbTablePrefix}Subscribers`,
			UpdateExpression: 'set #email = :email, #displayEmail = :displayEmail',
			Key: { subscriberId },
			ExpressionAttributeNames: {
				'#email': 'email',
				'#displayEmail': 'displayEmail',
			},
			ExpressionAttributeValues: {
				':email': newEmailLowerCase,
				':displayEmail': newDisplayEmail,
			},
		}).promise()

		// Update the subscriber's queue items with new email/displayEmail info.
		const promiseQueue = new PQueue({ concurrency: 10 });
		await queryAllForDynamoDB(
			dynamodb,
			{
				TableName: `${dbTablePrefix}Queue`,
				IndexName: `SubscriberIdIndex`,
				FilterExpression: '#queuePlacement = :queued',
				KeyConditionExpression: `#subscriberId = :subscriberId`,
				ExpressionAttributeNames: {
					'#subscriberId': 'subscriberId',
					'#queuePlacement': 'queuePlacement',
				},
				ExpressionAttributeValues: {
					':subscriberId': subscriberId,
					':queued': 'queued',
				},
			},
			{
				onEachItem: function(queueItem) {
					const { queuePlacement, runAtModified } = queueItem
					promiseQueue.add(async () => {
						await dynamodb.update({
							TableName: `${dbTablePrefix}Queue`,
							Key: { queuePlacement, runAtModified },
							UpdateExpression: 'set #subscriber.#email = :email, ' +
								'#subscriber.#displayEmail = :displayEmail',
							ExpressionAttributeNames: {
								'#subscriber': 'subscriber',
								'#email': 'email',
								'#displayEmail': 'displayEmail',
							},
							ExpressionAttributeValues: {
								':email': newEmailLowerCase,
								':displayEmail': newDisplayEmail,
							}
						}).promise()
					});
				},
				returnType: ReturnType.none,
			}
		);
		if (promiseQueue.size) {
			await promiseQueue.onIdle();
		}
		return {
			statusCode: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify('OK')
		}
	} catch (err) {
		return {
			statusCode: err.statusCode || 500,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify(err.message || 'Error')
		}
	}
}
