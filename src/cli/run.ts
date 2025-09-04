/* eslint-disable no-console */
/* This is one rare place where we're fine to use process/console directly,
 * but other code abstracts those to remain composable and testable. */
import Cli, { ICliRunResult } from './'
import VError from 'verror'
import { validateNodeEngineVersion } from './validate_node_engine_version'

function logErrorMessageAndExit(message: string): void {
  console.error(message)
  process.exit(1)
}

export default async function run(): Promise<void> {
  console.log('Running CLI...')
  validateNodeEngineVersion(
    process.version,
    (error) => {
      console.error(error)
      process.exit(1)
    },
    console.warn
  )
  console.log('Node engine version is valid.')

  const cli = new Cli({
    argv: process.argv,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  })

  let result: ICliRunResult
  try {
    result = await cli.run()
  } catch (error) {
    logErrorMessageAndExit(VError.fullStack(error))
  }

  const exitCode = result.success ? 0 : 1
  if (result.shouldExitImmediately) {
    process.exit(exitCode)
  } else {
    process.exitCode = exitCode
  }
}
