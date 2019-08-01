const AWS = require('aws-sdk')

const ses = new AWS.SES

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @param  {Any} body Data to be stringified as JSON.
 * @return {Object}
 */
const response = (statusCode, body) => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*'
		},
		body: JSON.stringify(body)
	}
}

/**
 * Gets the templates stored by SES.
 * @return {Promise}
 */
const getTemplates = nextToken => new Promise((resolve, reject) => {
	const params = {}
	if (nextToken) {
		params.NextToken = nextToken
	}
	ses.listTemplates(params, (err, data) => {
		if (err) {
			return reject(err)
		}
		return resolve(data)
	})
})

exports.handler = (event, context, callback) => {
	return getTemplates(
		event.queryStringParameters && event.queryStringParameters.nextToken
	)
	.then(result => callback(null, response(200, {
		templates: result.TemplatesMetadata,
		nextToken: result.NextToken,
	})))
	.catch(err => {
		console.log(`Error getting templates: ${err.message}`)
		return callback(null, response(500, err.message))
	})
}
