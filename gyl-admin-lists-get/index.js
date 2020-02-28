const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async () => {
	try {
		const dbResult = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: 'lists' },
		}).promise();
		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify((dbResult.Item && dbResult.Item.value) || []),
		};
	}
	catch (err) {
		console.error(err)
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(err.message),
		}
	}
};
