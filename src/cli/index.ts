import debug from 'debug'
import { loadConfiguration, runCucumber } from '../api'
import { ArgvParser } from '../configuration'
import { IFormatterStream } from '../formatter'
import { getRunName } from './helpers'
import { getKeywords, getLanguages } from './i18n'
import { validateInstall } from './install_validator'

export interface ICliRunResult {
  shouldExitImmediately: boolean
  success: boolean
}

export default class Cli {
  private readonly argv: string[]
  private readonly cwd: string
  private readonly stdout: IFormatterStream
  private readonly stderr: IFormatterStream
  private readonly env: NodeJS.ProcessEnv

  constructor({
    argv,
    cwd,
    stdout,
    stderr = process.stderr,
    env,
  }: {
    argv: string[]
    cwd: string
    stdout: IFormatterStream
    stderr?: IFormatterStream
    env: NodeJS.ProcessEnv
  }) {
    this.argv = argv
    this.cwd = cwd
    this.stdout = stdout
    this.stderr = stderr
    this.env = env
  }

  async run(): Promise<ICliRunResult> {
    const debugEnabled = debug.enabled('cucumber')
    if (debugEnabled) {
      await validateInstall()
    }
    const { options, configuration: argvConfiguration } = ArgvParser.parse(
      this.argv
    )
    argvConfiguration.runName = getRunName(argvConfiguration)
    if (argvConfiguration.bvtRerun) {
      process.env.BVT_FORMATTER = 'ANALYSIS'
    }
    if (options.i18nLanguages) {
      this.stdout.write(getLanguages())
      return {
        shouldExitImmediately: true,
        success: true,
      }
    }
    if (options.i18nKeywords) {
      this.stdout.write(getKeywords(options.i18nKeywords))
      return {
        shouldExitImmediately: true,
        success: true,
      }
    }

    const environment = {
      cwd: this.cwd,
      stdout: this.stdout,
      stderr: this.stderr,
      env: this.env,
      debug: debugEnabled,
    }
    const { useConfiguration: configuration, runConfiguration } =
      await loadConfiguration(
        {
          file: options.config,
          profiles: options.profile,
          provided: argvConfiguration,
        },
        environment
      )
    const { success } = await runCucumber(runConfiguration, environment)
    return {
      shouldExitImmediately: configuration.forceExit,
      success,
    }
  }
}
