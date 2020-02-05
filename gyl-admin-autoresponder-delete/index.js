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
		const autoresponderDef = JSON.parse(event.body)
		const { autoresponderId } = autoresponderDef
		if (!autoresponderId) {
			return response(400, 'Bad request: invalid autoresponder id')
		}
		await dynamodb.delete({
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: `autoresponder-${autoresponderId}` },
		}).promise()
		return response(204, '')
	}
	catch (err) {
		console.error(err)
		return response(500, err.message)
	}
}
