const AWS = require('aws-sdk')
const parse5 = require('parse5')

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

const getPreview = doc => {
	return ''
}

const getHtml = doc => {
	try {
		return parse5.serialize(doc.childNodes[1].childNodes[1])
	}
	catch (err) {
		return ''
	}
}

/**
 * Gets the SES email template.
 * @return {Promise}
 */
const getTemplate = templateName => new Promise((resolve, reject) => {
	ses.getTemplate({
		TemplateName: templateName
	}, (err, data) => {
		if (err) {
			return reject(err)
		}
		const doc = parse5.parse(data.Template.HtmlPart)
		return resolve(Object.assign({}, data.Template, {
			PreviewPart: getPreview(doc),
			HtmlPart: getHtml(doc),
		}))
	})
})

exports.handler = (event, context, callback) => {
	const templateName = event.queryStringParameters['template-name']
	if (!templateName) {
		return callback(null, response(400, null))
	}
	getTemplate(templateName)
	.then(result => callback(null, response(200, result)))
	.catch(err => {
		if (err.name === 'TemplateDoesNotExist') {
			return callback(null, response(404, 'Not found'))
		}
		console.log(`Error getting template: ${err.message}`)
		callback(null, response(500, null))
	})
}
