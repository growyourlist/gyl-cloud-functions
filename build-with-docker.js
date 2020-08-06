const {
	readdirSync,
	existsSync,
	createReadStream,
	createWriteStream
} = require('fs');
const { sep, join, resolve } = require('path');
const exec = require('util').promisify(require('child_process').exec);
const rimraf = require('rimraf');
const archiver = require('archiver');

const errorPattern = /(\berr\b|\berror\b)/i;
const isVerbose = !!process.env.VERBOSE
const Logger = {
	info: message => {
		if (isVerbose) {
			console.info(message)
		}
	},
	log: message => console.log(message),
	warn: message => console.warn(message),
	error: message => console.error(message),
}

const deleteNodeModulesFolder = async dir =>
	new Promise((resolve, reject) => {
		const nodeModulesDir = join(dir, 'node_modules');
		Logger.info(`Deleting directory ${nodeModulesDir}`);
		if (!existsSync(nodeModulesDir)) {
			resolve();
			return;
		}
		rimraf(join(nodeModulesDir), err => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});

const runDockerNpmInstall = async dir => {
	Logger.info(`Running "npm install" in ${dir}`);
	const cmd =
		`powershell -Command "docker run --rm -v ${dir}:/var/task ` +
		'lambci/lambda:build-nodejs12.x npm install `"--silent`""';
	const installOutput = await exec(cmd, { cwd: dir });
	const errOutput = installOutput.stderr;
	if (errorPattern.test(errOutput)) {
		throw new Error(
			`Error found in npm install output:\n${installOutput.stderr}`
		);
	}
};

const zipLambdaPackage = async dir => {
	return new Promise((resolve, reject) => {
		const zipPath = join(dir, 'dist.zip')
		var output = createWriteStream(zipPath);
		var archive = archiver('zip', { zlib: { level: 9 } });
		output.on('close', () => resolve());
		output.on('error', err => {
			output.destroy();
			archive.destroy();
			reject(err)
		});
		archive.pipe(output);
		archive.directory(`${join(dir, 'node_modules')}${sep}`, 'node_modules')
		const files = ['index.js', 'package.json', 'package-lock.json'];
		for (let i = 0; i < files.length; i++) {
			const filePath = join(dir, files[i])
			archive.append(createReadStream(filePath), {name: files[i]})
		}
		archive.finalize();
	});
};

const run = async () => {
	try {
		const dirs = readdirSync(__dirname, { withFileTypes: true })
			.filter(
				// Get all the directories containing package.json files, as these
				// should be the directories containing cloud function node packages.
				i =>
					i.isDirectory() && existsSync(`${__dirname}${sep}${i.name}${sep}package.json`)
			)
			.map(i => i.name);
		const targetFolderInput = process.argv[2] && resolve(process.argv[2])
		let targetFolders = targetFolderInput ? dirs.filter(dir => {
			return resolve(dir) === targetFolderInput;
		}) : dirs;
		let dirName = targetFolders.pop();
		while (dirName) {
			console.log(`Packing ${dirName}`);
			const dir = join(process.cwd(), dirName);
			await deleteNodeModulesFolder(dir);
			await new Promise(r => setTimeout(r, 500));
			await runDockerNpmInstall(dir);
			await new Promise(r => setTimeout(r, 500));
			await zipLambdaPackage(dir);
			dirName = targetFolders.pop();
		}
	} catch (err) {
		console.error(err);
	}
};

run();
