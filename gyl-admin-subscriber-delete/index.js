const AWS = require('aws-sdk');
const { queryAllForDynamoDB } = require('query-all-for-dynamodb');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();

const uuidv4Pattern = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

/**
 * Returns a response with HTTP details
 * @param {number} statusCode
 * @param {string} message
 */
const response = (statusCode, message = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(message),
	};
};

exports.handler = async event => {
	try {
		const email = event.queryStringParameters['email'];
		let subscriberId = event.queryStringParameters['subscriberId'];
		if ((!email && !subscriberId) || (email && subscriberId)) {
			return response(400, 'Bad request');
		}
		if (email) {
			if (typeof email !== 'string' || email.length < 1 || email.length > 256) {
				return response(400, 'Bad request. Invalid email.');
			}
			const subscriberResponse = await dynamodb.query({
				TableName: `${dbTablePrefix}Subscribers`,
				IndexName: 'EmailToStatusIndex',
				KeyConditionExpression: '#email = :email',
				ExpressionAttributeNames: { '#email': 'email' },
				ExpressionAttributeValues: { ':email': email },
			}).promise()
			if (!subscriberResponse.Items || !subscriberResponse.Items[0]) {
				return response(404, 'Not found')
			}
			subscriberId = subscriberResponse.Items[0].subscriberId
		} else if (
			typeof subscriberId !== 'string' ||
			uuidv4Pattern.test(subscriberId) !== true
		) {
			return response(400, 'Bad request. Invalid subscriber id.');
		}

		const itemsResponse = await queryAllForDynamoDB(dynamodb, {
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
		});
		const queueItems = itemsResponse.Count && itemsResponse.Items;
		if (Array.isArray(queueItems) && queueItems.length) {
			await writeAllForDynamoDB(dynamodb, {
				RequestItems: {
					[`${dbTablePrefix}Queue`]: queueItems.map(item => ({
						DeleteRequest: {
							Key: {
								queuePlacement: item.queuePlacement,
								runAtModified: item.runAtModified,
							},
						},
					})),
				},
			});
		}
		await dynamodb
			.delete({
				TableName: `${dbTablePrefix}Subscribers`,
				Key: { subscriberId: subscriberId },
			})
			.promise();
		return response(204);
	} catch (err) {
		console.error(err);
		return response(500, err.message);
	}
};
