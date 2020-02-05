const AWS = require('aws-sdk')
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX;

const response = (statusCode, body = '') => {
	return {
		statusCode: statusCode,
		headers: { 'Access-Control-Allow-Origin': '*' },
		body: JSON.stringify(body)
	}
}

exports.handler = async event => {
	try {
		const autoresponderId = event.queryStringParameters['autoresponderId']
		if (!autoresponderId) {
			return response(400, 'Bad request: invalid autoresponder id')
		}
		const autoresponderResponse = await dynamodb.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: `autoresponder-${autoresponderId}`},
		}).promise()
		if (!autoresponderResponse.Item || !autoresponderResponse.Item.value) {
			return response(404, 'Not found')
		}
		return response(200, autoresponderResponse.Item.value)
	}
	catch (err) {
		console.error(err)
		return response(500, err.message)
	}
}
