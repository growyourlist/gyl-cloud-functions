const AWS = require('aws-sdk')

const ses = new AWS.SES

/**
 * Attempts to parse request body JSON.
 * @param  {String} body Request body
 * @return {Object}
 */
const readTemplateData = body => {
	try {
		return JSON.parse(body)
	}
	catch (ex) {
		console.log(`Error reading request body: ${ex.message}`)
		return null
	}
}

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = statusCode => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*'
		}
	}
}

const wrapHtmlPart = (subject, htmlBody) => {
	return '<!DOCTYPE html>'
	+ '<html lang="en">'
	+ '<head>'
	+ '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'
	+ `<title>${subject}</title>`
	+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
	+ '</head>'
  + '<body style="background:#ffffff;color:#000000;">'
  + '<div style="background:#ffffff;color:#000000">'
  +  htmlBody
  + '</div>'
	+ '</body>'
	+ '</html>'
}

/**
 * Updates the template if it exists (i.e. TemplateName already exists) or
 * creates a new template if not.
 * @param  {Object} params
 * @return {Promise}
 */
const createTemplate = params => new Promise((resolve, reject) => {
	const templateParams = {
		TemplateName: params.TemplateName,
		SubjectPart: params.SubjectPart,
		HtmlPart: wrapHtmlPart(
			params.SubjectPart,
			params.HtmlPart,
		),
		TextPart: params.TextPart
	}
	ses.createTemplate({
		Template: templateParams
	}, (err, data) => {
		if (err && err.code === 'AlreadyExists') {
			ses.updateTemplate({
				Template: templateParams
			}, (innerErr, innerData) => {
				if (innerErr) {
					return reject(innerErr)
				}
				return resolve(innerData)
			})
		}
		else if (err) {
			return reject(err)
		}
		return resolve(data)
	})
})

exports.handler = (event, context, callback) => {
	const templateData = readTemplateData(event.body)
	if (!templateData) {
		return callback(null, response(400))
	}
	return createTemplate(templateData)
	.then(() => callback(null, response(200)))
	.catch(err => {
		console.log(`Error creating template: ${err.message}`)
		return callback(null, response(500))
	})
}
