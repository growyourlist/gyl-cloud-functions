const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async () => {
	try {
		const countResponse = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: 'previewSubscriberCount' },
		}).promise();
		if (!countResponse.Item) {
			return {
				statusCode: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: JSON.stringify('Not found'),
			};
		}
		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(countResponse.Item.value),
		};
	}
	catch (err) {
		console.error(err);
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(err.message)
		}
	}
}
