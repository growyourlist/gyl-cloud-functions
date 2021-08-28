const brcypt = require('bcrypt');

const getAdminPolicy = (methodArn, Effect) => {
	return {
		principalId: 'gyl-admin',
		policyDocument: {
			Version: '2012-10-17',
			Statement: [
				{
					Action: 'execute-api:Invoke',
					Effect,
					Resource: `${methodArn
						.split('/')
						.slice(0, 1)
						.join()}/*`,
				},
			],
		},
	}
}

const getSubscribeOnlyPolicy = (methodArn, Effect) => {
	return {
		principalId: 'gyl-subscriber-only',
		policyDocument: {
			Version: '2012-10-17',
			Statement: [
				{
					Action: 'execute-api:Invoke',
					Effect,
					Resource: methodArn
				},
			],
		},
	}
}

exports.authorizer = async event => {
	const headers = event.headers;
	const authKey = headers['x-gyl-auth-key'] || headers['X-Gyl-Auth-Key'] || headers['X-GYL-AUTH-KEY'];
	if ((typeof authKey !== 'string') || (!authKey.trim())) {
		console.log('deny: no key');
		return getAdminPolicy(event.methodArn, 'Deny')
	}
	const match = await brcypt.compare(
		authKey,
		process.env.ApiAuthKeyHash
	);
	if (match) {
		console.log('allow: admin key');
		return getAdminPolicy(event.methodArn, 'Allow');
	} else {
		if (event.methodArn && event.methodArn === process.env.POST_SUBSCRIBER_ADMIN_ARN) {
			const subscribeOnlyMatch = await brcypt.compare(
				authKey,
				process.env.ApiAuthSubscribeHashKey
			);
			if (subscribeOnlyMatch) {
				console.log('allow: subscribe-only key')
				return getSubscribeOnlyPolicy(event.methodArn, 'Allow');
			} else {
				console.log('deny: subscribe only key validation failed')
				return getSubscribeOnlyPolicy(event.methodArn, 'Deny')
			}
		}
		console.log('deny: admin key validation failed')
		return getSubscribeOnlyPolicy(event.methodArn, 'Deny')
	}
};
