const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const tagPattern = /^add-tag_([a-zA-Z0-9_-]{1,248})$/;

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberStatusByEmail = async (email) => {
	const response = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise();
	if (!response.Count || !response.Items[0]) {
		return null;
	}
	return response.Items[0];
};

/**
 * Adds a new tag to the given list of tags.
 */
const addTag = (tagName, tags) => {
	if (!tags || !tags.length) {
		return [tagName];
	}
	if (tags.indexOf(tagName) >= 0) {
		return tags;
	}
	return tags.concat([tagName]);
};

/**
 * Updates the subscriber based on the triggered interaction.
 */
const doTrigger = async (email, trigger, interaction) => {
	const subscriberStatus = await getSubscriberStatusByEmail(email);
	if (!subscriberStatus) {
		return;
	}

	const now = Date.now();
	const updateDef = {
		TableName: `${dbTablePrefix}Subscribers`,
		Key: { subscriberId: subscriberStatus.subscriberId },
		UpdateExpression: 'set #lastOpenOrClick = :lastOpenOrClick',
		ExpressionAttributeNames: { '#lastOpenOrClick': 'lastOpenOrClick' },
		ExpressionAttributeValues: { ':lastOpenOrClick': now },
	};
	const matches = trigger && trigger.match(tagPattern);
	if (matches) {
		const tag = matches[1];
		updateDef.UpdateExpression += ', #tags = :tags';
		updateDef.ExpressionAttributeNames['#tags'] = 'tags';
		updateDef.ExpressionAttributeValues[':tags'] = addTag(
			'active',
			addTag(tag, subscriberStatus.tags)
		);
		if (interaction === 'click' && process.env.AUTO_CONFIRM_TAGS) {
			const autoTagsRaw = process.env.AUTO_CONFIRM_TAGS.split(',').map((t) =>
				t.trim()
			);
			if (autoTagsRaw.indexOf(tag) >= 0) {
				updateDef.UpdateExpression += ', #confirmed = :confirmed';
				updateDef.ExpressionAttributeNames['#confirmed'] = 'confirmed';
				updateDef.ExpressionAttributeValues[
					':confirmed'
				] = new Date().toISOString();
			}
		}
	}
	if (interaction === 'click') {
		updateDef.UpdateExpression += ', #lastClick = :lastClick';
		updateDef.ExpressionAttributeNames['#lastClick'] = 'lastClick';
		updateDef.ExpressionAttributeValues[':lastClick'] = now;
	}
	if (interaction === 'open') {
		updateDef.UpdateExpression += ', #lastOpen = :lastOpen';
		updateDef.ExpressionAttributeNames['#lastOpen'] = 'lastOpen';
		updateDef.ExpressionAttributeValues[':lastOpen'] = now;
	}
	return await dynamodb.update(updateDef).promise();
};

const getTrigger = (tags, interaction) => {
	if (!tags || !Object.keys(tags).length) {
		return null;
	}
	if (interaction === 'click' && tags['Interaction-Click']) {
		return tags['Interaction-Click'][0];
	} else if (interaction === 'open' && tags['Interaction-Open']) {
		return tags['Interaction-Open'][0];
	}
	return null;
};

const updateQueueItem = async (tags, interaction) => {
	if (!(interaction === 'click' || interaction === 'open')) {
		return;
	}
	if (
		typeof tags !== 'object' ||
		!Array.isArray(tags['DateStamp']) ||
		!Array.isArray(tags['RunAtModified'])
	) {
		return;
	}
	const dateStampType = typeof tags['DateStamp'][0];
	const runAtModifiedType = typeof tags['RunAtModified'][0];
	if (
		!(
			dateStampType === runAtModifiedType &&
			dateStampType === 'string' &&
			/\d{4}-\d{2}-\d{2}/.test(tags['DateStamp'][0]) &&
			/\d+_\d+/.test(tags['RunAtModified'][0])
		)
	) {
		return;
	}
	const nowInSeconds = Date.now();
	try {
		await dynamodb
			.update({
				TableName: `${dbTablePrefix}Queue`,
				Key: {
					queuePlacement: tags['DateStamp'][0],
					runAtModified: tags['RunAtModified'][0].replace('_', '.'),
				},
				UpdateExpression: 'set #clickOrOpen = :nowInSeconds',
				ConditionExpression:
					'attribute_exists(#queuePlacement) and ' +
					'attribute_exists(#runAtModified)',
				ExpressionAttributeNames: {
					'#clickOrOpen': interaction,
					'#queuePlacement': 'queuePlacement',
					'#runAtModified': 'runAtModified',
				},
				ExpressionAttributeValues: {
					':nowInSeconds': nowInSeconds,
				},
			})
			.promise();
	} catch (err) {
		if (err.name === 'ConditionalCheckFailedException') {
			// The queue item does not exist, ignore
			return;
		}
		throw err;
	}
};

exports.handler = async (event) => {
	try {
		const message = JSON.parse(event.Records[0].Sns.Message);
		const interaction = message.eventType.toLowerCase(); // E.g. Open or Click
		// Ignore clicks on unsubscribe links
		if (
			interaction === 'click' &&
			message.click &&
			typeof message.click.link === 'string' &&
			/unsubscribe/.test(message.click.link)
		) {
			return;
		}
		const email = message.mail.destination[0];
		const trigger = getTrigger(message.mail.tags, interaction);
		await Promise.all([
			doTrigger(email, trigger, interaction),
			updateQueueItem(message.mail.tags, interaction),
		]);
	} catch (err) {
		console.error(err);
	}
};
