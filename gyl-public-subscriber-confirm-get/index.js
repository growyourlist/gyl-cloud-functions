const AWS = require('aws-sdk');

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();
const uuidv4Pattern = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, message = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: message,
	};
};

/**
 * Gets a subscriber by their id.
 * @param  {String} subscriberId
 * @return {Promise<Object>}
 */
const getSubscriber = subscriberId =>
	dynamodb
		.get({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberId },
		})
		.promise();

/**
 * Sets the confirmed status of a subscriber to true.
 * @param  {Object} subscriberData
 * @return {Promise}
 */
const confirmSubscriber = subscriberId =>
	dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId },
			ConditionExpression: 'attribute_exists(#subscriberId)',
			UpdateExpression:
				'set #confirmed = :true, #unsubscribed = :false, #confirmTimestamp = :timestamp',
			ExpressionAttributeNames: {
				'#subscriberId': 'subscriberId',
				'#confirmed': 'confirmed',
				'#unsubscribed': 'unsubscribed',
				'#confirmTimestamp': 'confirmTimestamp',
			},
			ExpressionAttributeValues: {
				':true': true,
				':false': false,
				':timestamp': Date.now(),
			},
		})
		.promise();

exports.handler = async event => {
	try {
		const subscriberId = event.queryStringParameters['t'];
		if (uuidv4Pattern.test(subscriberId) !== true) {
			return response(400, JSON.stringify('Bad request'));
		}
		const result = await getSubscriber(subscriberId);
		if (!result || !result.Item) {
			return response(404, JSON.stringify('Not found'));
		}
		if (result.Item.confirmed && !result.Item.unsubscribed) {
			return {
				statusCode: 307,
				headers: {
					'Access-Control-Allow-Origin': '*',
					Location: process.env.THANKYOU_URL,
				},
			};
		}

		await confirmSubscriber(subscriberId)
		return {
			statusCode: 307,
			headers: {
				'Access-Control-Allow-Origin': '*',
				Location: process.env.THANKYOU_URL,
			},
		}
	} catch (err) {
		console.error(err);
		return response(500, 'Error');
	}
};
