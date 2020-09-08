const AWS = require('aws-sdk');
const parse5 = require('parse5');

const ses = new AWS.SES();

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
			'Access-Control-Allow-Origin': '*',
		},
		body: JSON.stringify(body),
	};
};

const getHtml = (doc) => {
	const body = doc.childNodes[1].childNodes[1];
	if (body.childNodes.length > 1) {
		return parse5.serialize(body);
	}
	if (body.childNodes.length === 1) {
		const firstBodyElm = body.childNodes[0];
		if (firstBodyElm.tagName !== 'div') {
			return parse5.serialize(body);
		}
		const styleAttr =
			firstBodyElm.attrs &&
			firstBodyElm.attrs.find((attr) => {
				return attr.name === 'style';
			});
		if (!styleAttr) {
			return parse5.serialize(body);
		}
		const isBackgroundDiv = styleAttr.value.startsWith(
			'background:#ffffff;color:#000000'
		);
		if (isBackgroundDiv) {
			return parse5.serialize(firstBodyElm);
		}
		return parse5.serialize(body);
	}
	return '';
};

/**
 * Gets the SES email template.
 * @return {Promise}
 */
const getTemplate = async (templateName) => {
	const templateData = await ses
		.getTemplate({
			TemplateName: templateName,
		})
		.promise();
	const doc = parse5.parse(templateData.Template.HtmlPart);
	return Object.assign({}, templateData.Template, {
		PreviewPart: '',
		HtmlPart: getHtml(doc),
	});
};

exports.handler = async (event) => {
	try {
		const templateName = event.queryStringParameters['templateName'];
		if (!templateName) {
			return response(400, null);
		}
		const template = await getTemplate(templateName);
		return response(200, template);
	} catch (err) {
		if (err.name === 'TemplateDoesNotExist') {
			return response(404, 'Not found');
		}
		console.error(err);
		return response(500, err.message);
	}
};
