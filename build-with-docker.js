const {
	readdirSync,
	existsSync,
	createReadStream,
	createWriteStream,
} = require('fs');
const { sep, join, resolve } = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const rimrafCore = require('rimraf');
const rimraf = promisify(rimrafCore);
const archiver = require('archiver');

const errorPattern = /(\berr\b|\berror\b)/i;
const isVerbose = !!process.env.VERBOSE;
const Logger = {
	info: (message) => {
		if (isVerbose) {
			console.info(message);
		}
	},
	log: (message) => console.log(message),
	warn: (message) => console.warn(message),
	error: (message) => console.error(message),
};

const deleteNodeModulesFolder = async (dir) => {
	const nodeModulesDir = join(dir, 'node_modules');
	Logger.info(`Deleting directory ${nodeModulesDir}`);
	if (!existsSync(nodeModulesDir)) {
		return;
	}
	await rimraf(nodeModulesDir);
};

const runDockerNpmInstall = async (dir) => {
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

const zipLambdaPackage = (dir) => new Promise((resolve, reject) => {
	const zipPath = join(dir, 'dist.zip');
	const output = createWriteStream(zipPath);
	const archive = archiver('zip', { zlib: { level: 9 } });
	output.on('close', () => {
		resolve();
	});
	output.on('error', (err) => {
		output.destroy();
		archive.destroy();
		reject(err);
	});
	archive.pipe(output);
	const nodeModulesDir = `${join(dir, 'node_modules')}${sep}`;
	const nodeModulesBinDir = join(nodeModulesDir, '.bin');
	const packDir = async () => {
		try {
			if (existsSync(nodeModulesBinDir)) {
				await rimraf(nodeModulesBinDir);
			}
			archive.directory(nodeModulesDir, 'node_modules');
			const files = ['index.js', 'package.json', 'package-lock.json'];
			for (let i = 0; i < files.length; i++) {
				const filePath = join(dir, files[i]);
				archive.append(createReadStream(filePath), { name: files[i] });
			}
			await archive.finalize();
		} catch (err) {
			reject(err);
		}
	}
	packDir();
});

const run = async () => {
	try {
		const dirs = readdirSync(__dirname, { withFileTypes: true })
			.filter(
				// Get all the directories containing package.json files, as these
				// should be the directories containing cloud function node packages.
				(i) =>
					i.isDirectory() &&
					existsSync(`${__dirname}${sep}${i.name}${sep}package.json`)
			)
			.map((i) => i.name);
		const targetFolderInput = process.argv[2] && resolve(process.argv[2]);
		let targetFolders = targetFolderInput
			? dirs.filter((dir) => {
					return resolve(dir) === targetFolderInput;
				})
			: dirs;
		await Promise.all(
			targetFolders.map(async (dirName) => {
				const dir = join(process.cwd(), dirName);
				await new Promise((r) =>
					setTimeout(r, Math.round(10000 * Math.random()))
				);
				await deleteNodeModulesFolder(dir);
				await new Promise((r) =>
					setTimeout(r, Math.round(200 + Math.random() * 1000))
				);
				await runDockerNpmInstall(dir);
				await new Promise((r) =>
					setTimeout(r, Math.round(200 + Math.random() * 1000))
				);
				await zipLambdaPackage(dir);
				console.log(`Packed ${dirName}`);
			})
		);
		console.log(`Complete`);
	} catch (err) {
		console.error(err);
	}
};

run();
