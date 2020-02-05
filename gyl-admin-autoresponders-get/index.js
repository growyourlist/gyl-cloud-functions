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

exports.handler = async () => {
	try {
		const autorespondersResponse = await dynamodb.scan({
			TableName: `${dbTablePrefix}Settings`,
			FilterExpression: 'begins_with(settingName, :autoresponder)',
			ExpressionAttributeValues: {
				':autoresponder': 'autoresponder-'
			}
		}).promise()
		const autoresponders = (
			autorespondersResponse.Items &&
			autorespondersResponse.Items.map(i => i.value)
		) || []
		return response(200, autoresponders)
	}
	catch (err) {
		console.error(err)
		return response(500, err.message)
	}
}
