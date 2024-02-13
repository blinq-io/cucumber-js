import * as messages from '@cucumber/messages'

// type JsonException = messages.Exception
type JsonTimestamp = number //messages.Timestamp
type JsonStepType = 'Unknown' | 'Context' | 'Action' | 'Outcome'

export type JsonResultUnknown = {
  status: 'UNKNOWN'
}
type JsonResultSkipped = {
  status: 'SKIPPED'
}
type JsonResultUndefined = {
  status: 'UNDEFINED'
}
type JsonResultAmbiguous = {
  status: 'AMBIGUOUS'
}
export type JsonResultStarted = {
  status: 'STARTED'
  startTime: JsonTimestamp
}
type JsonResultPending = {
  status: 'PENDING'
  startTime: JsonTimestamp
  endTime: JsonTimestamp
}
export type JsonResultPassed = {
  status: 'PASSED'
  startTime: JsonTimestamp
  endTime: JsonTimestamp
}
export type JsonResultFailed = {
  status: 'FAILED'
  startTime: JsonTimestamp
  endTime: JsonTimestamp
  message?: string
  // exception?: JsonException
}
export type JsonFixedByAi = {
  status: 'FIXED_BY_AI'
  startTime: JsonTimestamp
  endTime: JsonTimestamp
}

type JsonCommandResult = JsonResultPassed | JsonResultFailed
type JsonStepResult =
  | JsonResultUnknown
  | JsonResultSkipped
  | JsonResultUndefined
  | JsonResultAmbiguous
  | JsonResultStarted
  | JsonResultPending
  | JsonResultPassed
  | JsonResultFailed
  | JsonFixedByAi
export type JsonTestResult =
  | JsonResultUnknown
  | JsonResultStarted
  | JsonResultPassed
  | JsonResultFailed
  | JsonFixedByAi
type JsonReportResult = JsonTestResult

type JsonCommand = {
  type: string
  value?: string
  text: string
  screenshotId?: string
  result: JsonCommandResult
}
export type JsonStep = {
  type: JsonStepType
  text: string
  commands: JsonCommand[]
  result: JsonStepResult
}

export type JsonTestProgress = {
  id: string
  featureName: string
  uri: string
  scenarioName: string
  parameters: Record<string, string>
  steps: JsonStep[]
  result: JsonTestResult
}

export type JsonReport = {
  testCases: JsonTestProgress[]
  result: JsonReportResult
}

export default class ReportGenerator {
  private report: JsonReport = {
    result: {
      status: 'UNKNOWN',
    },
    testCases: [] as JsonTestProgress[],
  }
  private gherkinDocumentMap = new Map<string, messages.GherkinDocument>()
  private pickleMap = new Map<string, messages.Pickle>()
  private testCaseMap = new Map<string, messages.TestCase>()
  private testStepMap = new Map<string, messages.TestStep>()
  private stepProgressMap = new Map<string, JsonStep>()
  private testProgressMap = new Map<string, JsonTestProgress>()

  reportFolder: null | string = null

  handleMessage(envelope: messages.Envelope) {
    const type = Object.keys(envelope)[0] as keyof messages.Envelope
    switch (type) {
      // case "meta": { break}
      // case "source": { break}
      case 'parseError': {
        const parseError = envelope[type]
        this.handleParseError(parseError)
        break
      }
      case 'gherkinDocument': {
        const doc = envelope[type]
        this.onGherkinDocument(doc)
        break
      }
      case 'pickle': {
        const pickle = envelope[type]
        this.onPickle(pickle)
        break
      }
      // case "stepDefinition": { break}
      // case "hook": { break} // Before Hook
      case 'testRunStarted': {
        const testRunStarted = envelope[type]
        this.onTestRunStarted(testRunStarted)
        break
      }
      case 'testCase': {
        const testCase = envelope[type]
        this.onTestCase(testCase)
        break
      }
      case 'testCaseStarted': {
        const testCaseStarted = envelope[type]
        this.onTestCaseStarted(testCaseStarted)
        break
      }
      case 'testStepStarted': {
        const testStepStarted = envelope[type]
        this.onTestStepStarted(testStepStarted)
        break
      }
      case 'attachment': {
        const attachment = envelope[type]
        this.onAttachment(attachment)
        break
      }
      case 'testStepFinished': {
        const testStepFinished = envelope[type]
        this.onTestStepFinished(testStepFinished)
        break
      }
      case 'testCaseFinished': {
        const testCaseFinished = envelope[type]
        this.onTestCaseFinished(testCaseFinished)
        break
      }
      // case "hook": { break} // After Hook
      case 'testRunFinished': {
        const testRunFinished = envelope[type]
        this.onTestRunFinished(testRunFinished)
        break
      }
      // case "parameterType" : { break}
      // case "undefinedParameterType": { break}
    }
  }
  getReport() {
    return this.report
  }
  private handleParseError(parseError: messages.ParseError) {
    const { message, source } = parseError
    const timestamp = new Date().getTime()
    this.report.result = {
      status: 'FAILED',
      startTime: timestamp,
      endTime: timestamp,
      message: message,
    }
  }
  private onGherkinDocument(doc: messages.GherkinDocument) {
    this.gherkinDocumentMap.set(doc.uri, doc)
  }
  private onPickle(pickle: messages.Pickle) {
    this.pickleMap.set(pickle.id, pickle)
  }
  private getTimeStamp(timestamp: messages.Timestamp) {
    return timestamp.seconds * 1000 + timestamp.nanos / 1000000
  }
  private onTestRunStarted(testRunStarted: messages.TestRunStarted) {
    this.report.result = {
      status: 'STARTED',
      startTime: this.getTimeStamp(testRunStarted.timestamp),
    }
  }
  private onTestCase(testCase: messages.TestCase) {
    this.testCaseMap.set(testCase.id, testCase)
    testCase.testSteps.forEach((testStep) => {
      this.testStepMap.set(testStep.id, testStep)
    })
  }
  private onTestCaseStarted(testCaseStarted: messages.TestCaseStarted) {
    const { testCaseId, id, timestamp } = testCaseStarted
    const testCase = this.testCaseMap.get(testCaseId)
    if (testCase === undefined)
      throw new Error(`testCase with id ${testCaseId} not found`)
    const pickle = this.pickleMap.get(testCase.pickleId)
    if (pickle === undefined)
      throw new Error(`pickle with id ${testCase.pickleId} not found`)

    const doc = this.gherkinDocumentMap.get(pickle.uri)
    if (doc === undefined)
      throw new Error(`gherkinDocument with uri ${pickle.uri} not found`)
    const featureName = doc.feature.name

    const scenarioName = pickle.name

    const steps: JsonStep[] = pickle.steps.map((step) => {
      this.stepProgressMap.set(step.id, {
        type: step.type,
        text: step.text,
        commands: [],
        result: {
          status: 'UNKNOWN',
        },
      })
      return this.stepProgressMap.get(step.id)
    })
    this.testProgressMap.set(id, {
      id,
      uri: pickle.uri,
      featureName,
      scenarioName,
      // TODO: compute parameters
      parameters: {},
      steps,
      result: {
        status: 'STARTED',
        startTime: this.getTimeStamp(timestamp),
      },
    })
    this.report.testCases.push(this.testProgressMap.get(id))
  }
  private onTestStepStarted(testStepStarted: messages.TestStepStarted) {
    const { testStepId, timestamp, testCaseStartedId } = testStepStarted
    const testStep = this.testStepMap.get(testStepId)
    if (testStep === undefined)
      throw new Error(`testStep with id ${testStepId} not found`)
    if (testStep.pickleStepId === undefined) return
    const stepProgess = this.stepProgressMap.get(testStep.pickleStepId)
    stepProgess.result = {
      status: 'STARTED',
      startTime: this.getTimeStamp(timestamp),
    }
  }
  private onAttachment(attachment: messages.Attachment) {
    const {
      testCaseStartedId,
      testStepId,
      body,
      mediaType,
      contentEncoding,
      fileName,
      source,
      url,
    } = attachment
    if (mediaType === 'text/plain') {
      this.reportFolder = body.replaceAll('\\', '/')
    }
    const testStep = this.testStepMap.get(testStepId)
    if (testStep.pickleStepId === undefined) return

    const stepProgess = this.stepProgressMap.get(testStep.pickleStepId)
    if (mediaType === 'application/json') {
      const command: JsonCommand = JSON.parse(body)
      stepProgess.commands.push(command)
    }
  }
  private onTestStepFinished(testStepFinished: messages.TestStepFinished) {
    const { testStepId, testCaseStartedId, testStepResult, timestamp } =
      testStepFinished
    const testStep = this.testStepMap.get(testStepId)
    if (testStep.pickleStepId === undefined) return
    const stepProgess = this.stepProgressMap.get(testStep.pickleStepId)
    const prevStepResult = stepProgess.result as {
      status: 'STARTED'
      startTime: JsonTimestamp
    }
    stepProgess.result = {
      status: testStepResult.status,
      startTime: prevStepResult.startTime,
      endTime: this.getTimeStamp(timestamp),
      message: testStepResult.message,
      // exception: testStepResult.exception,
    }
  }
  private getTestCaseResult(steps: JsonStep[]) {
    for (const step of steps) {
      switch (step.result.status) {
        case 'FAILED':
          return {
            status: step.result.status,
            message: step.result.message,
            // exception: step.result.exception,
          } as const
        case 'AMBIGUOUS':
        case 'UNDEFINED':
        case 'PENDING':
          return {
            status: 'FAILED',
            message: `step "${step.text}" is ${step.result.status}`,
          } as const
      }
    }
    return {
      status: 'PASSED',
    } as const
  }
  private onTestCaseFinished(testCaseFinished: messages.TestCaseFinished) {
    const { testCaseStartedId, timestamp } = testCaseFinished
    const testProgress = this.testProgressMap.get(testCaseStartedId)
    const prevResult = testProgress.result as {
      status: 'STARTED'
      startTime: JsonTimestamp
    }
    const steps = Object.values(testProgress.steps)
    const result = this.getTestCaseResult(steps)
    testProgress.result = {
      ...result,
      startTime: prevResult.startTime,
      endTime: this.getTimeStamp(timestamp),
    }
  }
  private onTestRunFinished(testRunFinished: messages.TestRunFinished) {
    const { timestamp, success, exception, message } = testRunFinished
    const prevResult = this.report.result as {
      status: 'STARTED'
      startTime: JsonTimestamp
    }
    this.report.result = {
      status: success ? 'PASSED' : 'FAILED',
      startTime: prevResult.startTime,
      endTime: this.getTimeStamp(timestamp),
      message,
      // exception,
    }
  }
}