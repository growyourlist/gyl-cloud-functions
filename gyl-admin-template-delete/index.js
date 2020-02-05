const AWS = require('aws-sdk');
const ses = new AWS.SES();

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, body) => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
		body,
	};
};

exports.handler = async event => {
	try {
		let templateData = null;
		try {
			templateData = JSON.parse(event.body);
			if (
				!templateData.TemplateName ||
				typeof templateData.TemplateName !== 'string'
			) {
				throw new Error('Invalid template name');
			}
		} catch (err) {
			return response(400, `Bad request: ${err.message}`);
		}
		const { TemplateName } = templateData
		await ses.deleteTemplate({ TemplateName }).promise()
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err)
		return response(500, JSON.stringify(err.message));
	}
}
