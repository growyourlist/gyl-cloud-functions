const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const response = (statusCode, body) => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
		body: JSON.stringify(body),
	};
};

exports.handler = async event => {
	try {
		const autoresponderData = JSON.parse(event.body);
		if (
			typeof autoresponderData.autoresponderId !== 'string' ||
			autoresponderData.autoresponderId.length < 1
		) {
			return response(400, 'Bad request')
		}
		// TODO: add to validation so that all steps are checked and the
		// autoresponder has a good shape.
		await dynamodb
			.put({
				TableName: `${dbTablePrefix}Settings`,
				Item: {
					settingName: `autoresponder-${autoresponderData.autoresponderId}`,
					value: autoresponderData,
				},
			})
			.promise();
		return response(200, 'OK');
	} catch (err) {
		console.error(err);
		return response(500, err.message);
	}
};
