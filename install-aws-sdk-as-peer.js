const { readFileSync, existsSync, writeFileSync } = require('fs');
const { join } = require('path');
const exec = require('util').promisify(require('child_process').exec);

const run = async () => {
	try {
		const cwd = process.cwd();
		const packageFile = join(cwd, 'package.json');
		if (!existsSync(packageFile)) {
			throw new Error(`Package file not found: ${packageFile}`);
		}
		const packageContent = readFileSync(packageFile);
		const packageInfo = JSON.parse(packageContent);
		if (typeof packageInfo.peerDependencies !== 'object') {
			packageInfo.peerDependencies = {};
		}
		const installResult = await exec(`npm install --no-save aws-sdk`);
		const awsPattern = /\baws-sdk@(\d+\.\d+\.\d+)\b/;
		const awsPatternMatch = installResult.stdout.match(awsPattern);
		if (!awsPatternMatch) {
			throw new Error(
				'"npm install --no-save aws-sdk" may not have run correctly, error: ' +
					(installResult.stderr || '<undefined>')
			);
		}
		packageInfo.peerDependencies['aws-sdk'] = `^${awsPatternMatch[1]}`;
		writeFileSync(packageFile, JSON.stringify(packageInfo, null, 2) + '\n');
		console.log(installResult.stdout.trim())
	} catch (err) {
		console.error(err);
	}
};
run();
