const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const unsubscribeSchema = Joi.object({
	email: Joi.string()
		.lowercase()
		.email()
		.required(),
});

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberIdByEmail = async email => {
	const subscriberResponse = await dynamodb.query({
		TableName: `${dbTablePrefix}Subscribers`,
		IndexName: 'EmailToStatusIndex',
		KeyConditionExpression: 'email = :email',
		ExpressionAttributeValues: {
			':email': email,
		},
	}).promise();
	return (
		(subscriberResponse.Items &&
			subscriberResponse.Items[0] &&
			subscriberResponse.Items[0].subscriberId) ||
		null
	);
};

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, body) => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	};
};

const unsubscribeSubscriber = async subscriberId => {
	await dynamodb.update({
		TableName: `${dbTablePrefix}Subscribers`,
		Key: { subscriberId: subscriberId },
		UpdateExpression: 'set #unsubscribed = :true',
		ExpressionAttributeNames: { '#unsubscribed': 'unsubscribed' },
		ExpressionAttributeValues: { ':true': true },
	}).promise()
	const queueResponse = await dynamodb.query({
		TableName: `${dbTablePrefix}Queue`,
		IndexName: 'SubscriberIdIndex',
		KeyConditionExpression: '#subscriberId = :subscriberId',
		FilterExpression: '#queuePlacement = :queued',
		ExpressionAttributeNames: {
			'#subscriberId': 'subscriberId',
			'#queuePlacement': 'queuePlacement',
		},
		ExpressionAttributeValues: {
			':subscriberId': subscriberId,
			':queued': 'queued',
		},
	}).promise()
	if (!queueResponse.Items || !queueResponse.Items.length) {
		return;
	}
	await writeAllForDynamoDB(dynamodb, {
		RequestItems: {
			[`${dbTablePrefix}Queue`]: queueResponse.Items.map(item => ({
				DeleteRequest: {
					Key: {
						queuePlacement: item.queuePlacement,
						runAtModified: item.runAtModified,
					}
				}
			}))
		}
	})
}

exports.handler = async event => {
	try {
		let unsubscribeData = null
		try {
			unsubscribeData = await unsubscribeSchema.validateAsync(
				JSON.parse(event.body)
			);
		}
		catch (err) {
			return response(400, `Bad request: ${err.message}`)
		}
		const subscriberId = await getSubscriberIdByEmail(unsubscribeData.email)
		if (!subscriberId) {
			return response(404, 'Not found')
		}
		await unsubscribeSubscriber(subscriberId)
		return response(200, 'OK');
	} catch (err) {
		console.error(err);
		return response(500, 'Server error');
	}
}
