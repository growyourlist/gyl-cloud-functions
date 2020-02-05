const AWS = require('aws-sdk')
const ses = new AWS.SES()

exports.handler = async (event) => {
	try {
		let requestBody = null
		requestBody = JSON.parse(event.body)
		const Body = {}
		if (typeof requestBody.body === 'string') {
			if (requestBody.body.trim().indexOf('html>') >= 0) {
				Body.Html = {
					Data: requestBody.body.trim(),
					Charset: "UTF-8",
				}
			}
			else {
				Body.Text = {
					Data: requestBody.body,
					Charset: "UTF-8",
				}
			}
		}
		else if (typeof requestBody.body === 'object') {
			if (requestBody.body.html) {
				Body.Html = {
					Data: requestBody.body.html,
					Charset: 'UTF-8',
				}
			}
			if (requestBody.body.text) {
				Body.Text = {
					Data: requestBody.body.text,
					Charset: 'UTF-8',
				}
			}
		}
		console.log(Body)
		await (new Promise((resolve, reject) => ses.sendEmail({
			Destination: {
				ToAddresses: [ requestBody.toEmailAddress ],
			},
			Source: requestBody.fromEmailAddress || process.env.SOURCE_EMAIL_ADDRESS,
			Message: {
				Subject: {
					Data: requestBody.subject,
					Charset: 'UTF-8'
				},
				Body,
			},
		}, (err, data) => {
			if (err) {
				return reject(err)
			}
			resolve(data)
		})))
		const response = {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify('OK'),
		};
		return response;
	}
	catch (err) {
		console.error(err)
		const response = {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(`Error: ${err.message}`)
		}
		return response
	}
}
