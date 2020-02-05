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
		await dynamodb.put({
			TableName: `${dbTablePrefix}Settings`,
			Item: {
				settingName: `autoresponder-${autoresponderDef.autoresponderId}`,
				value: autoresponderDef
			}
		}).promise()
		return response(200, 'OK')
	}
	catch (err) {
		console.error(err)
		return response(500, err.message)
	}
}
