const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async () => {
  try {
    const history = await dynamodb.get({
      TableName: `${dbTablePrefix}Settings`,
      Key: { settingName: 'broadcastHistory' },
		}).promise();
    const response = {
      headers: { 'Access-Control-Allow-Origin': '*' },
      statusCode: 200,
      body: JSON.stringify((history.Item && history.Item.value) || []),
    }
    return response
  }
  catch (err) {
    console.error(err)
    const response = {
      headers: { 'Access-Control-Allow-Origin': '*' },
      statusCode: 500,
      body: JSON.stringify(err.message),
    }
    return response
  }
}
