require('dotenv').config();

exports.handler = async () => {
	try {
		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(process.env.UNSUBSCRIBE_LINK),
		};
	}
	catch (err) {
		console.error(err)
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(err.message),
		}
	}
};
