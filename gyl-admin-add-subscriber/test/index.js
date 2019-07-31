require('dotenv').config()
const assert = require('assert')

const handler = require('../index').handler

// Tests require .env file to be set and local dynamodb to be running. E.g.
// TEST_AWS_REGION="us-east-1"
// TEST_AWS_DB_ENDPOINT="http://localhost:8000"

// TODO: Greatly expand the range of test cases!

const testMinStandardCase = async () => {
	return handler(
		{
			body: JSON.stringify({
				email: "person@example.com"
			}),
		},
		null,
		(params, response) => {
			assert.strictEqual(response.statusCode, 200)
		}
	)
}

const testInvalidEmail = async () => {
	return handler(
		{
			body: JSON.stringify({
				email: "@@@example.com"
			}),
		},
		null,
		(params, response) => {
			assert.strictEqual(response.statusCode, 400)
		}
	)
}

const runTests = async () => {
	try {
		await testMinStandardCase()
		await testInvalidEmail()
	}
	catch (err) {
		console.error(err)
	}
}

runTests()
