const AWS = require('aws-sdk');
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();

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
			'Content-Type': 'application/json; charset=utf-8',
		},
		body,
	};
};

exports.handler = async event => {
	try {
		const email = event.queryStringParameters['email'];
		if (typeof email !== 'string' || email.length < 1 || email.length > 256) {
			return response(400, 'Bad request');
		}
		const subscriberEmail = email.toLocaleLowerCase();
		const subscriberResponse = await dynamodb
			.query({
				TableName: `${dbTablePrefix}Subscribers`,
				IndexName: 'EmailToStatusIndex',
				KeyConditionExpression: 'email = :email',
				ExpressionAttributeValues: {
					':email': subscriberEmail,
				},
			})
			.promise();
		const subscriber = subscriberResponse.Count && subscriberResponse.Items[0];
		if (!subscriber) {
			return response(404, 'Not found');
		}
		return response(200, JSON.stringify(subscriber));
	} catch (err) {
		console.error(err);
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
