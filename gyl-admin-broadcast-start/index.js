const AWS = require('aws-sdk')
const dynamodb = require('dynopromise-client')
const Joi = require('@hapi/joi')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const broadcastSchema = Joi.object().keys({
	templateId: Joi.string().regex(/^[\w-]+$/).required(),
	tags: Joi.array().items(Joi.string().regex(/^[\w-]+$/).min(1).max(128)),
	properties: Joi.object(),
	runAt: Joi.number().allow(null).greater(Date.now() - 5000),
	interactions: Joi.array().items(Joi.object().keys({
		templateId: Joi.string().regex(/^[\w-]+$/).required(),
		emailDate: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		click: Joi.boolean(),
		open: Joi.boolean(),
	})),
})

const db = dynamodb()
const ses = new AWS.SES()

/**
 * Attempts to parse request body JSON.
 * @param  {String} body Request body
 * @return {Object}
 */
const getInput = body => {
	try {
		return JSON.parse(body)
	}
	catch (ex) {
		return null
	}
}

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
			'Content-Type': 'text/plain; charset=utf-8',
		},
		body,
	}
}

exports.handler = (event, context, callback) => {
	const broadcastData = getInput(event.body)
	broadcastSchema.validate(broadcastData)
	.then(opts => new Promise(
		(resolve, reject) => ses.getTemplate({
			TemplateName: broadcastData.templateId
		}, (err, data) => {
			if (err) {
				return reject(err)
			}
			db.put({
				TableName: `${dbTablePrefix}Settings`,
				Item: {
					settingName: 'pendingBroadcast',
					value: opts
				}
			})
			.then(() => resolve())
			.catch(err => reject(err))
		}
	)))
	.then(() => callback(null, response(200, 'OK')))
	.catch(err => {
		console.log(`Error sending broadcast: ${err.message}`)
		return callback(null, response(500, err.message))
	})
}
