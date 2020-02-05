const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate the triggering of a broadcast.
const broadcastSchema = Joi.object({
	TemplateName: Joi.string()
		.regex(/^[\w-]+$/)
		.required(),
	tags: Joi.array().items(
		Joi.string()
			.regex(/^[\w-]+$/)
			.min(1)
			.max(128)
	),
	properties: Joi.object(),
	runAt: Joi.number()
		.allow(null)
		.greater(Date.now() - 86400000),
	interactions: Joi.array().items(
		Joi.object().keys({
			templateId: Joi.string()
				.regex(/^[\w-]+$/)
				.required(),
			emailDate: Joi.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.required(),
			click: Joi.boolean(),
			open: Joi.boolean(),
		})
	),
});

const ses = new AWS.SES();
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
		let broadcast = null;
		try {
			broadcast = await broadcastSchema.validateAsync(JSON.parse(event.body));
		}
		catch (err) {
			return response(400, `Bad request: ${err.message}`)
		}
		const { TemplateName } = broadcast;
		// Check the template exists by trying to fetch it
		await ses.getTemplate({ TemplateName }).promise();
		const isDoingBroadcastResponse = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Settings`,
				Key: { settingName: 'isDoingBroadcast' },
			})
			.promise();
		if (
			isDoingBroadcastResponse.Item &&
			isDoingBroadcastResponse.Item.isDoingBroadcast
		) {
			throw new Error('A broadcast is already in progress. Try again later.');
		}
		await dynamodb.put({
			TableName: `${dbTablePrefix}Settings`,
			Item: {
				settingName: 'pendingBroadcast',
				value: broadcast,
			},
		}).promise();
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
