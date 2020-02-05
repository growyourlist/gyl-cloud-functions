const AWS = require('aws-sdk');
const { fullQueryForDynamoDB, ReturnType } = require('full-query-for-dynamodb');

const db = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || ''

const bucketStamp = timestamp => {
	return 9e5 + timestamp - (timestamp % 9e5);
};

exports.handler = async event => {
	try {
		const { templateId, date } = event.queryStringParameters;
		if (!templateId || !date) {
			return {
				headers: { 'Access-Control-Allow-Origin': '*' },
				statusCode: 400,
				body: 'Bad request',
			};
		}
		const sends = {};
		const opens = {};
		const clicks = {};
		await fullQueryForDynamoDB(
			db,
			{
				TableName: `${dbTablePrefix}Queue`,
				KeyConditionExpression: '#qp = :qp',
				FilterExpression: '#ti = :ti',
				ProjectionExpression: '#la,#c,#o',
				ExpressionAttributeNames: {
					'#qp': 'queuePlacement',
					'#ti': 'templateId',
					'#la': 'lastAttempt',
					'#c': 'click',
					'#o': 'open',
				},
				ExpressionAttributeValues: {
					':qp': date,
					':ti': templateId,
				},
			},
			{
				returnType: ReturnType.none,
				onEachItem: async item => {
					const sendBucket = bucketStamp(item.lastAttempt);
					if (sends[sendBucket]) {
						sends[sendBucket] += 1;
					} else {
						sends[sendBucket] = 1;
					}
					if (item.click && !item.open) {
						const clickBucket = bucketStamp(item.click);
						if (clicks[clickBucket]) {
							clicks[clickBucket] += 1;
						} else {
							clicks[clickBucket] = 1;
						}
						if (opens[clickBucket]) {
							opens[clickBucket] += 1;
						} else {
							opens[clickBucket] += 1;
						}
						return;
					}
					if (item.click) {
						const clickBucket = bucketStamp(item.click);
						if (clicks[clickBucket]) {
							clicks[clickBucket] += 1;
						} else {
							clicks[clickBucket] = 1;
						}
					}
					if (item.open) {
						const openBucket = bucketStamp(item.open);
						if (opens[openBucket]) {
							opens[openBucket] += 1;
						} else {
							opens[openBucket] = 1;
						}
					}
				},
			}
		);

		const response = {
			headers: {
				'Access-Control-Allow-Origin': '*',
			},
			statusCode: 200,
			body: JSON.stringify({
				sends,
				opens,
				clicks,
			}),
		};
		return response;
	} catch (err) {
		console.error(err);
		const response = {
			headers: {
				'Access-Control-Allow-Origin': '*',
			},
			statusCode: 500,
			body: 'Error',
		};
		return response;
	}
};
