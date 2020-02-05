const AWS = require('aws-sdk');
const { queryAllForDynamoDB } = require('query-all-for-dynamodb');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async event => {
	try {
		// Validate that a valid email is passed in.
		if (
			!event.queryStringParameters ||
			typeof event.queryStringParameters.email !== 'string' ||
			event.queryStringParameters.email.length > 256 ||
			event.queryStringParameters.email.length < 1
		) {
			return {
				statusCode: 400,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: 'Bad request',
			};
		}

		// Get the subscriber, if they exist.
		const { email } = event.queryStringParameters;
		const subscriberStatusResponse = await dynamodb
			.query({
				TableName: `${dbTablePrefix}Subscribers`,
				KeyConditionExpression: '#email = :email',
				IndexName: 'EmailToStatusIndex',
				ExpressionAttributeNames: {
					'#email': 'email',
				},
				ExpressionAttributeValues: {
					':email': email,
				},
			})
			.promise();

		// Exit if there's no subscriber at this point.
		if (
			!subscriberStatusResponse ||
			!Array.isArray(subscriberStatusResponse.Items) ||
			!subscriberStatusResponse.Items[0] ||
			!subscriberStatusResponse.Items[0].subscriberId
		) {
			return {
				statusCode: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: 'Not Found',
			};
		}

		// Fetch the history for the subscriber.
		const { subscriberId } = subscriberStatusResponse.Items[0];
		const historyResponse = await queryAllForDynamoDB(dynamodb, {
			TableName: `${dbTablePrefix}Queue`,
			IndexName: 'SubscriberIdIndex',
			KeyConditionExpression: '#subscriberId = :subscriberId',
			ExpressionAttributeNames: {
				'#subscriberId': 'subscriberId',
			},
			ExpressionAttributeValues: {
				':subscriberId': subscriberId,
			},
		});
		let history = (historyResponse.Items || [])
		history.sort((a, b) => b.runAt - a.runAt);
		history = history.slice(0, 100)
		const itemDetails = await dynamodb
			.batchGet({
				RequestItems: {
					[`${dbTablePrefix}Queue`]: {
						Keys: history.map(item => {
							const { queuePlacement, runAtModified } = item;
							return { queuePlacement, runAtModified };
						}),
					},
				},
			})
			.promise();
		const fullItems = (itemDetails.Responses.Queue || [])
		return {
			statusCode: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(fullItems),
		};
	} catch (err) {
		console.error(err);
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: 'Server error',
		};
	}
};
