import { Envelope, Meta } from '@cucumber/messages'
import { spawn } from 'child_process'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { tmpName } from 'tmp'
import Formatter, { IFormatterOptions } from '.'
import { doesHaveValue } from '../value_checker'
import ReportGenerator, {
  JsonReport,
  JsonTestProgress,
  JsonTestResult,
  RetrainStats,
} from './helpers/report_generator'
import ReportUploader from './helpers/uploader'
import os from 'os'
import { getProjectByAccessKey } from './api'
import SummaryFormatter from './summary_formatter'
import { ActionEvents, SERVICES_URI } from './helpers/constants'
import { axiosClient } from '../configuration/axios_client'
import {
  FinishTestCaseResponse,
  RootCauseProps,
} from './helpers/upload_serivce'
import { promisify } from 'util'
import { exec } from 'child_process'

//User token
const TOKEN = process.env.TOKEN
interface MetaMessage extends Meta {
  runName: string
}

interface EnvelopeWithMetaMessage extends Envelope {
  meta: MetaMessage
}
export let globalReportLink = ''
export default class BVTAnalysisFormatter extends Formatter {
  static reportGenerator: ReportGenerator
  static reRunFailedStepsIndex:
    | { testCaseId: string; failedStepIndex: number }[]
    | null
  private reportGenerator = new ReportGenerator()
  private uploader = new ReportUploader(this.reportGenerator)
  private exit = false
  private START: number
  private runName: string
  private failedStepsIndex: { testCaseId: string; failedStepIndex: number }[]
  private summaryFormatter: SummaryFormatter
  private rootCauseArray: {
    rootCause: RootCauseProps
    report: JsonTestProgress
  }[] = []

  constructor(options: IFormatterOptions) {
    super(options)
    this.summaryFormatter = new SummaryFormatter(options)
    BVTAnalysisFormatter.reportGenerator = this.reportGenerator
    this.rootCauseArray = []
    this.failedStepsIndex = []
    BVTAnalysisFormatter.reRunFailedStepsIndex = process.env.RERUN
      ? JSON.parse(process.env.RERUN)
      : null

    if (!TOKEN && process.env.BVT_FORMATTER === 'ANALYSIS') {
      throw new Error('TOKEN must be set')
    }
    this.sendEvent(ActionEvents.cli_run_tests)
    options.eventBroadcaster.on(
      'envelope',
      async (envelope: EnvelopeWithMetaMessage, data?: any) => {
        if (doesHaveValue(envelope.testCaseFinished) && data) {
          const { rootCause, report } = data as FinishTestCaseResponse

          if (!rootCause.status) {
            console.error(
              `Root cause: ${rootCause.failClass}\n, ${rootCause.analysis}\nfailing step: ${rootCause.failedStep}`
            )
            this.rootCauseArray.push({ rootCause, report })
            this.failedStepsIndex.push({
              testCaseId: report.id,
              failedStepIndex: rootCause.failedStep,
            })
          }
          return
        }
        await this.reportGenerator.handleMessage(envelope)

        if (
          doesHaveValue(envelope.meta) &&
          doesHaveValue(envelope.meta.runName)
        ) {
          this.runName = envelope.meta.runName
        }
        if (doesHaveValue(envelope.testRunFinished)) {
          this.START = Date.now()
          if (process.env.BVT_FORMATTER === 'ANALYSIS') {
            await this.analyzeReport()
          } else {
            // await this.uploadReport(report)
          }
          this.exit = true
        }
      }
    )
  }

  private sendEvent(event: ActionEvents) {
    axiosClient
      .post(
        `${SERVICES_URI.STORAGE}/event`,
        {
          event,
        },
        {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'x-source': 'cucumber_js',
          },
        }
      )
      .catch((err) => {
        // Error with events, ignoring
      })
  }

  private async uploadReport(report: JsonReport) {
    const uploadSuccessful = await this.uploadFinalReport(report)
    if (uploadSuccessful && report.result.status !== 'FAILED') {
      process.exit(0)
    }
    process.exit(1)
  }

  async finished(): Promise<any> {
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        let anyRem
        if (process.env.UPLOADING_TEST_CASE) {
          anyRem = JSON.parse(process.env.UPLOADING_TEST_CASE) as string[]
        } else {
          anyRem = undefined
        }

        if (this.exit && (!anyRem || anyRem.length === 0)) {
          // clearInterval(checkInterval)
          // resolve(null)
          if (this.reportGenerator.getReport().result.status === 'FAILED') {
            process.exit(1)
          } else {
            process.exit(0)
          }
        }
      }, 100) // check every 100ms
    })
  }
  private async analyzeReport() {
    if (
      this.rootCauseArray.length === 0 ||
      process.env.NO_RETRAIN === 'false'
    ) {
      if (this.rootCauseArray.length === 0) {
        this.log('No test failed. No need to retrain\n')
      }
      if (process.env.NO_RETRAIN === 'false') {
        this.log(
          'Retraining is skipped since the failed step contains an API request\n'
        )
      }
      // const uploadSuccessful = await this.uploadFinalReport(report)
      // process.exit(0)
      this.exit = true
      return
    }

    //checking if the type of report.result is JsonResultFailed or not

    this.log('Some tests failed, starting the retraining...\n')
    await this.processTestCases()
    if (this.reportGenerator.getReport().result.status === 'FAILED') {
      process.exit(1)
    }
    process.exit(0)
  }
  private async processTestCases() {
    for (const { rootCause, report } of this.rootCauseArray) {
      await this.processTestCase(rootCause, report)
    }
  }
  private async processTestCase(
    rootCause: RootCauseProps,
    report: JsonTestProgress
  ) {
    const failedTestSteps = rootCause.failedStep

    if (
      BVTAnalysisFormatter.reRunFailedStepsIndex &&
      BVTAnalysisFormatter.reRunFailedStepsIndex.length > 0
    ) {
      const previousRun = BVTAnalysisFormatter.reRunFailedStepsIndex[0]
      if (previousRun.failedStepIndex === failedTestSteps) {
        console.log('Same step has failed again, skipping retraining')
        BVTAnalysisFormatter.reRunFailedStepsIndex.shift()
        return
      }
      BVTAnalysisFormatter.reRunFailedStepsIndex.shift()
    }

    const retrainStats = await this.retrain(failedTestSteps, report)

    if (!retrainStats) {
      return
    }

    await this.uploader.modifyTestCase({
      ...report,
      retrainStats,
    })

    await this.rerun(report)
  }

  private async uploadFinalReport(finalReport: JsonReport) {
    let success = true
    try {
      const { projectId, runId } = await this.uploader.uploadRun(
        finalReport,
        this.runName
      )
      logReportLink(runId, projectId)
    } catch (err) {
      this.log('Error uploading report\n')
      if ('stack' in err) {
        this.log(err.stack)
      }
      success = false
    } finally {
      try {
        writeFileSync(
          path.join(this.reportGenerator.reportFolder, 'report.json'),
          JSON.stringify(finalReport, null, 2),
          'utf-8'
        )
      } catch (e) {
        console.error('failed to write report.json to local disk')
      }
    }

    //this.log(JSON.stringify(finalReport, null, 2))
    return success
  }
  private async retrain(
    failedTestCases: number,
    testCase: JsonTestProgress
  ): Promise<RetrainStats | null> {
    const data = await getProjectByAccessKey(TOKEN)
    const currentTimestampInSeconds = Math.floor(Date.now() / 1000)
    if (data.project.expriration_date < currentTimestampInSeconds) {
      console.log(
        'Warning: Your project has expired, retraining is restricted. Please contact sales.'
      )
      process.exit(1)
    }
    return await this.call_cucumber_client(failedTestCases, testCase)
  }

  private async rerun(report: JsonTestProgress) {
    await new Promise<void>((resolve) => {
      const node_path = process.argv.shift()
      const args = [
        path.join(
          process.cwd(),
          'node_modules',
          '@dev-blinq',
          'cucumber-js',
          'bin',
          'cucumber.js'
        ),
        '--name',
        `^${report.scenarioName}$`,
        '--exit',
        '--format',
        'bvt',
        '--run-name',
        `${report.scenarioName}@debug`,
        path.join(process.cwd(), 'features', `${report.featureName}.feature`),
      ]
      const cucumberClient = spawn(node_path, args, {
        env: {
          ...process.env,
          RERUN: JSON.stringify(this.failedStepsIndex),
        },
      })

      cucumberClient.stdout.on('data', (data) => {
        console.log(data.toString())
      })

      cucumberClient.stderr.on('data', (data) => {
        console.error(data.toString())
      })

      cucumberClient.on('close', () => {
        resolve()
      })
    })
  }

  private async call_cucumber_client(
    stepsToRetrain: number,
    testCase: JsonTestProgress
  ): Promise<RetrainStats | null> {
    return new Promise((resolve, reject) => {
      const cucumber_client_path = path.resolve(
        process.cwd(),
        'node_modules',
        '@dev-blinq',
        'cucumber_client',
        'bin',
        'client',
        'cucumber.js'
      )

      const args: string[] = [
        process.cwd(),
        path.join(process.cwd(), testCase.uri),
        `${testCase.scenarioName}`,
        'undefined',
        `${stepsToRetrain},`,
      ]

      if (process.env.BLINQ_ENV) {
        args.push(`--env=${process.env.BLINQ_ENV}`)
      }

      if (!existsSync(path.join(this.getAppDataDir(), 'blinq.io', '.temp'))) {
        mkdir(path.join(this.getAppDataDir(), 'blinq.io', '.temp'), {
          recursive: true,
        })
      }

      tmpName(async (err, name) => {
        const tempFile = path.join(
          this.getAppDataDir(),
          'blinq.io',
          '.temp',
          path.basename(name)
        )
        console.log('File path: ', tempFile)
        await writeFile(tempFile, '', 'utf-8')

        args.push(`--temp-file=${tempFile}`)
        const cucumberClient = spawn('node', [cucumber_client_path, ...args], {
          env: {
            ...process.env,
          },
        })

        cucumberClient.stdout.on('data', (data) => {
          console.log(data.toString())
        })

        cucumberClient.stderr.on('data', (data) => {
          console.error(data.toString())
        })

        cucumberClient.on('close', async (code) => {
          if (code === 0) {
            const reportData = readFileSync(tempFile, 'utf-8')
            const retrainStats = JSON.parse(reportData) as RetrainStats
            await unlink(tempFile)
            resolve(retrainStats)
          } else {
            this.log('Error retraining\n')
            try {
              const reportData = readFileSync(tempFile, 'utf-8')
              const retrainStats = JSON.parse(reportData) as RetrainStats
              await unlink(tempFile)
              resolve(retrainStats)
            } catch (e) {
              this.log('Error  reading scenario report\n ' + e)
              resolve(null)
            }
          }
        })
      })
    })
  }

  private getAppDataDir() {
    if (process.env.BLINQ_APPDATA_DIR) {
      return process.env.BLINQ_APPDATA_DIR
    }

    let appDataDir: string

    switch (process.platform) {
      case 'win32':
        appDataDir = process.env.APPDATA!
        break
      case 'darwin':
        appDataDir = path.join(os.homedir(), 'Library', 'Application Support')
        break
      default:
        appDataDir = path.join(os.homedir(), '.config')
        break
    }
    return appDataDir
  }
}

export function logReportLink(runId: string, projectId: string) {
  let reportLinkBaseUrl = 'https://app.blinq.io'
  if (process.env.NODE_ENV_BLINQ === 'local') {
    reportLinkBaseUrl = 'http://localhost:3000'
  } else if (process.env.NODE_ENV_BLINQ === 'dev') {
    reportLinkBaseUrl = 'https://dev.app.blinq.io'
  } else if (process.env.NODE_ENV_BLINQ === 'stage') {
    reportLinkBaseUrl = 'https://stage.app.blinq.io'
  } else if (process.env.NODE_ENV_BLINQ === 'prod') {
    reportLinkBaseUrl = 'https://app.blinq.io'
  } else if (!process.env.NODE_ENV_BLINQ) {
    reportLinkBaseUrl = 'https://app.blinq.io'
  } else {
    reportLinkBaseUrl = process.env.NODE_ENV_BLINQ.replace('api', 'app')
  }
  const reportLink = `${reportLinkBaseUrl}/${projectId}/run-report/${runId}`
  globalReportLink = reportLink
  try {
    publishReportLinkToGuacServer(reportLink)
  } catch (err) {
    // Error with events, ignoring
  }
  return reportLink
}

function publishReportLinkToGuacServer(reportLink: string) {
  if (existsSync('/tmp/report_publish.sh')) {
    const execAsync = promisify(exec)
    execAsync('sh /tmp/report_publish.sh ' + reportLink)
  }
}
