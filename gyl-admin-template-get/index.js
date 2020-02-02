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
const getTemplate = async templateName => {
	const templateData = await ses.getTemplate({
		TemplateName: templateName
	}).promise()
	const doc = parse5.parse(templateData.Template.HtmlPart)
	return Object.assign({}, templateData.Template, {
		PreviewPart: '',
		HtmlPart: getHtml(doc),
	})
}

exports.handler = async event => {
	try {
		const templateName = event.queryStringParameters['template-name']
		if (!templateName) {
			return response(400, null)
		}
		const template = await getTemplate(templateName)
		return response(200, template)
	}
	catch (err) {
		if (err.name === 'TemplateDoesNotExist') {
			return response(404, 'Not found')
		}
		console.error(err)
		return response(500, err.message)
	}
}
