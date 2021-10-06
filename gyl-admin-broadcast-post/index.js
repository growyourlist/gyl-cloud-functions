const AWS = require('aws-sdk');
const Joi = require('joi');
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate the triggering of a broadcast.
const broadcastSchema = Joi.object({
	templates: Joi.array()
		.items(
			Joi.object({
				name: Joi.string()
					.regex(/^[\w-]+$/)
					.required(),
				testPercent: Joi.number().min(0).max(100).required(),
			})
		)
		.min(1),
	templateId: Joi.when('templates', {
		is: Joi.exist(),
		then: Joi.forbidden(),
		otherwise: Joi.string()
			.regex(/^[\w-]+$/)
			.required(),
	}),
	list: Joi.string()
		.regex(/^[\w-]+$/)
		.min(1)
		.max(128)
		.required(),
	tags: Joi.array().items(
		Joi.string()
			.regex(/^[\w-]+$/)
			.min(1)
			.max(128)
	),
	excludeTags: Joi.array().items(
		Joi.string()
			.regex(/^[\w-]+$/)
			.min(1)
			.max(128)
	),
	tagOnClick: Joi.string().allow('').regex(/^[\w-]+$/).max(64),
	properties: Joi.object(),
	runAt: Joi.number()
		.allow(null)
		.greater(Date.now() - 86400000),
	subscriberRunAt: Joi.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
	datetimeContext: Joi.string().valid('utc', 'subscriber'),
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
	ignoreConfirmed: Joi.boolean(),
	interactionWithAnyEmail: Joi.alternatives().try(
		Joi.any().allow(null),
		Joi.object({
			interactionType: Joi.string().valid('clicked', 'opened or clicked'),
			interactionPeriodValue: Joi.number().min(0),
			interactionPeriodUnit: Joi.string().valid('days'),
		})
	),
	winningType: Joi.alternatives().try(
		Joi.any().allow(null),
		Joi.string().valid(
			'content: email with most clicks',
			'subject: email with most opens',
			'auto-merge subject (most opens) and content (most clicks) into new email'
		)
	),
	joinedAfter: Joi.number().allow(null),
}).unknown(false);

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

const getRunAt = (broadcast) => {
	if (broadcast.datetimeContext === 'subscriber') {
		if (!broadcast.subscriberRunAt) {
			throw new Error('If using subscriber\'s timezone, date/time must be set');
		}
		// subscriberRunAt has been validated to be in format ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$
		// Start queuing items at the earliest moment in the day by setting runAt
		// to use +12 offset, i.e. the first timezone to experience a given date/time
		// TODO check if it's safe to use +14 offset.
		return `${Date.parse(`${broadcast.subscriberRunAt}:00.000+12:00`)}${Math.random().toString().substr(1)}`
	}
	return `${parseInt(
		broadcast.runAt || Date.now()
	)}${Math.random().toString().substr(1)}`;
}

exports.handler = async (event) => {
	try {
		let broadcast = null;
		try {
			broadcast = await broadcastSchema.validateAsync(JSON.parse(event.body));
		} catch (err) {
			return response(400, `Bad request: ${err.message}`);
		}
		if (broadcast.templateId) {
			const TemplateName = broadcast.templateId;
			// Check the template exists by trying to fetch it
			await ses.getTemplate({ TemplateName }).promise();
		} else {
			await Promise.all(
				broadcast.templates.map(async (template) => {
					await ses.getTemplate({ TemplateName: template.name }).promise();
				})
			);
		}
		const Item = Object.assign({}, broadcast, {
			runAt: getRunAt(broadcast),
			// Merge list into list of tags to search for, as it is just a tag itself.
			tags: (broadcast.tags && broadcast.tags.concat(broadcast.list)) || [
				broadcast.list,
			],
			phase: 'pending',
		});
		delete Item.list;
		await dynamodb
			.put({
				TableName: `${dbTablePrefix}BroadcastQueue`,
				Item,
			})
			.promise();
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(
			err.statusCode || 500,
			JSON.stringify(err.message || 'Error')
		);
	}
};
