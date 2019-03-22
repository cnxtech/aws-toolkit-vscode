/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as path from 'path'
import * as tcpPortUsed from 'tcp-port-used'
import * as vscode from 'vscode'
import { buildHandlerConfig, getLocalLambdaConfiguration, HandlerConfig } from '../../lambda/local/configureLocalLambda'
import { detectLocalLambdas } from '../../lambda/local/detectLocalLambdas'
import { CloudFormation } from '../cloudformation/cloudformation'
import { writeFile } from '../filesystem'
import { makeTemporaryToolkitFolder } from '../filesystemUtilities'
import { SamCliBuildInvocation, SamCliBuildInvocationArguments } from '../sam/cli/samCliBuild'
import { SamCliProcessInvoker, SamCliTaskInvoker } from '../sam/cli/samCliInvoker'
import { SamCliLocalInvokeInvocation } from '../sam/cli/samCliLocalInvoke'
import { SettingsConfiguration } from '../settingsConfiguration'
import { SamTemplateGenerator } from '../templates/sam/samTemplateGenerator'
import { ExtensionDisposableFiles } from '../utilities/disposableFiles'

import { DebugConfiguration } from '../../lambda/local/debugConfiguration'
import { ChannelLogger, getChannelLogger, localize } from '../utilities/vsCodeUtils'

export interface LambdaLocalInvokeParams {
    document: vscode.TextDocument,
    range: vscode.Range,
    handlerName: string,
    isDebug: boolean,
    workspaceFolder: vscode.WorkspaceFolder,
}

export interface SAMTemplateEnvironmentVariables {
    [resource: string]: {
        [key: string]: string
    }
}

export interface OnDidSamBuildParams {
    buildDir: string,
    debugPort: number,
    handlerName: string,
    isDebug: boolean
}

const TEMPLATE_RESOURCE_NAME: string = 'awsToolkitSamLocalResource'
const SAM_LOCAL_PORT_CHECK_RETRY_INTERVAL_MILLIS: number = 125
const SAM_LOCAL_PORT_CHECK_RETRY_TIMEOUT_MILLIS_DEFAULT: number = 30000

// TODO: Consider replacing LocalLambdaRunner use with associated duplicative functions
export class LocalLambdaRunner {

    private static readonly TEMPLATE_RESOURCE_NAME: string = 'awsToolkitSamLocalResource'
    private static readonly SAM_LOCAL_PORT_CHECK_RETRY_INTERVAL_MILLIS: number = 125
    private static readonly SAM_LOCAL_PORT_CHECK_RETRY_TIMEOUT_MILLIS_DEFAULT: number = 30000

    private _baseBuildFolder?: string
    private readonly _debugPort?: number

    public constructor(
        private readonly configuration: SettingsConfiguration,
        private readonly localInvokeParams: LambdaLocalInvokeParams,
        debugPort: number | undefined,
        private readonly runtime: string,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly processInvoker: SamCliProcessInvoker,
        private readonly taskInvoker: SamCliTaskInvoker,
        private readonly debugConfig: DebugConfiguration,
        private readonly codeRootDirectoryPath: string,
        private readonly manifestPath?: string,
        private readonly onDidSamBuild?: (params: OnDidSamBuildParams) => Promise<void>,
        private readonly onWillAttachDebugger?: () => Promise<void>,
        private readonly channelLogger = getChannelLogger(outputChannel),
    ) {
        if (localInvokeParams.isDebug && !debugPort) {
            throw new Error('Debug port must be provided when launching in debug mode')
        }

        this._debugPort = debugPort
    }

    public async run(): Promise<void> {
        try {
            // Switch over to the output channel so the user has feedback that we're getting things ready
            this.channelLogger.channel.show(true)

            this.channelLogger.info(
                'AWS.output.sam.local.start',
                'Preparing to run {0} locally...',
                this.localInvokeParams.handlerName
            )

            const inputTemplate: string = await this.generateInputTemplate(this.codeRootDirectoryPath)
            const samBuildTemplate: string = await this.executeSamBuild(this.codeRootDirectoryPath, inputTemplate)

            await this.invokeLambdaFunction(samBuildTemplate)

        } catch (err) {
            // TODO: logger.error?
            console.log(err)
            const error = err as Error

            // TODO: Define standard/strategy. Sometimes err.message is/isn't part of msg "Error: {0}". Discuss.
            this.outputChannel.appendLine(
                localize(
                    'AWS.output.sam.local.error',
                    'Error: {0}',
                    error.message
                )
            )

            vscode.window.showErrorMessage(
                localize(
                    'AWS.error.during.sam.local',
                    'An error occurred trying to run SAM Application locally: {0}',
                    error.message
                )
            )

            return
        }

    }

    public get debugPort(): number {
        if (!this._debugPort) {
            throw new Error('Debug port was expected but is undefined')
        }

        return this._debugPort
    }

    private async getBaseBuildFolder(): Promise<string> {
        // TODO: Clean up folder structure
        if (!this._baseBuildFolder) {
            this._baseBuildFolder = await makeTemporaryToolkitFolder()
            ExtensionDisposableFiles.getInstance().addFolder(this._baseBuildFolder)
        }

        return this._baseBuildFolder
    }

    /**
     * Create the SAM Template that will be passed in to sam build.
     * @returns Path to the generated template file
     */
    private async generateInputTemplate(
        rootCodeFolder: string
    ): Promise<string> {
        const buildFolder: string = await this.getBaseBuildFolder()
        const inputTemplatePath: string = path.join(buildFolder, 'input', 'input-template.yaml')

        // Make function handler relative to baseDir
        const handlerFileRelativePath = path.relative(
            rootCodeFolder,
            path.dirname(this.localInvokeParams.document.uri.fsPath)
        )

        const relativeFunctionHandler = path.join(
            handlerFileRelativePath,
            this.localInvokeParams.handlerName
        ).replace('\\', '/')

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.localInvokeParams.workspaceFolder.uri)
        let existingTemplateResource: CloudFormation.Resource | undefined
        if (workspaceFolder) {
            const lambdas = await detectLocalLambdas([workspaceFolder])
            const existingLambda = lambdas.find(lambda => lambda.handler === relativeFunctionHandler)
            existingTemplateResource = existingLambda ? existingLambda.resource : undefined
        }

        let newTemplate = new SamTemplateGenerator()
            .withCodeUri(rootCodeFolder)
            .withFunctionHandler(relativeFunctionHandler)
            .withResourceName(LocalLambdaRunner.TEMPLATE_RESOURCE_NAME)
            .withRuntime(this.runtime)

        if (existingTemplateResource && existingTemplateResource.Properties &&
            existingTemplateResource.Properties.Environment) {
            newTemplate = newTemplate.withEnvironment(existingTemplateResource.Properties.Environment)
        }

        await newTemplate.generate(inputTemplatePath)

        return inputTemplatePath
    }

    private async executeSamBuild(
        rootCodeFolder: string,
        inputTemplatePath: string
    ): Promise<string> {
        this.channelLogger.info(
            'AWS.output.building.sam.application',
            'Building SAM Application...'
        )

        const samBuildOutputFolder = path.join(await this.getBaseBuildFolder(), 'output')

        const samCliArgs: SamCliBuildInvocationArguments = {
            buildDir: samBuildOutputFolder,
            baseDir: rootCodeFolder,
            templatePath: inputTemplatePath,
            invoker: this.processInvoker
        }
        if (this.manifestPath) {
            samCliArgs.manifestPath = this.manifestPath
        }
        await new SamCliBuildInvocation(samCliArgs).execute()

        this.channelLogger.info(
            'AWS.output.building.sam.application.complete',
            'Build complete.'
        )

        if (this.onDidSamBuild) {
            // Enable post build tasks if needed
            await this.onDidSamBuild({
                buildDir: samBuildOutputFolder,
                debugPort: this._debugPort!, // onDidSamBuild will only be called for debug, _debugPort will be defined
                handlerName: this.localInvokeParams.handlerName,
                isDebug: this.localInvokeParams.isDebug
             })
        }

        return path.join(samBuildOutputFolder, 'template.yaml')
    }

    /**
     * Runs `sam local invoke` against the provided template file
     * @param samTemplatePath sam template to run locally
     */
    private async invokeLambdaFunction(
        samTemplatePath: string,
    ): Promise<void> {
        this.channelLogger.info(
            'AWS.output.starting.sam.app.locally',
            'Starting the SAM Application locally (see Terminal for output)'
        )

        const eventPath: string = path.join(await this.getBaseBuildFolder(), 'event.json')
        const environmentVariablePath = path.join(await this.getBaseBuildFolder(), 'env-vars.json')
        const config = await this.getConfig()

        await writeFile(eventPath, JSON.stringify(config.event || {}))
        await writeFile(
            environmentVariablePath,
            JSON.stringify(this.getEnvironmentVariables(config))
        )

        const command = new SamCliLocalInvokeInvocation({
            templateResourceName: LocalLambdaRunner.TEMPLATE_RESOURCE_NAME,
            templatePath: samTemplatePath,
            eventPath,
            environmentVariablePath,
            debugPort: (!!this._debugPort) ? this._debugPort.toString() : undefined,
            invoker: this.taskInvoker
        })

        await command.execute()

        if (this.localInvokeParams.isDebug) {
            this.channelLogger.info(
                'AWS.output.sam.local.waiting',
                'Waiting for SAM Application to start before attaching debugger...'
            )

            const timeoutMillis = this.configuration.readSetting<number>(
                'samcli.debug.attach.timeout.millis',
                LocalLambdaRunner.SAM_LOCAL_PORT_CHECK_RETRY_TIMEOUT_MILLIS_DEFAULT
            )

            await tcpPortUsed.waitUntilUsed(
                this.debugPort,
                LocalLambdaRunner.SAM_LOCAL_PORT_CHECK_RETRY_INTERVAL_MILLIS,
                timeoutMillis
            )

            await this.attachDebugger()
        }
    }

    private async getConfig(): Promise<HandlerConfig> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.localInvokeParams.document.uri)
        if (!workspaceFolder) {
            return buildHandlerConfig()
        }

        const config: HandlerConfig = await getLocalLambdaConfiguration(
            workspaceFolder,
            this.localInvokeParams.handlerName
        )

        return config
    }

    private getEnvironmentVariables(config: HandlerConfig): SAMTemplateEnvironmentVariables {
        if (!!config.environmentVariables) {
            return {
                [LocalLambdaRunner.TEMPLATE_RESOURCE_NAME]: config.environmentVariables
            }
        } else {
            return {}
        }
    }

    private async attachDebugger() {
        if (this.onWillAttachDebugger) {
            // Enable caller to do last minute preparation before attaching debugger
            await this.onWillAttachDebugger()
        }
        this.channelLogger.info(
            'AWS.output.sam.local.attaching',
            'Attaching to SAM Application...'
        )
        const attachSuccess: boolean = await vscode.debug.startDebugging(undefined, this.debugConfig)

        if (attachSuccess) {
            this.channelLogger.info(
                'AWS.output.sam.local.attach.success',
                'Debugger attached'
            )
        } else {
            // sam local either failed, or took too long to start up
            this.channelLogger.error(
                'AWS.output.sam.local.attach.failure',
                // tslint:disable-next-line:max-line-length
                'Unable to attach Debugger. Check the Terminal tab for output. If it took longer than expected to successfully start, you may still attach to it.'
            )
        }
    }
}

// tslint:disable-next-line:max-line-length
export async function run({baseBuildDir, channelLogger, codeDir, configuration, debugConfig, documentUri, handlerName, isDebug, localInvokeParams, manifestPath, runtime, samProcessInvoker, samTaskInvoker, workspaceUri}: {
    baseBuildDir: string,
    channelLogger: ChannelLogger,
    codeDir: string,
    configuration: SettingsConfiguration,
    debugConfig: DebugConfiguration,
    documentUri: vscode.Uri,
    handlerName: string,
    isDebug?: boolean,
    localInvokeParams: LambdaLocalInvokeParams,
    manifestPath?: string,
    runtime: string,
    samProcessInvoker: SamCliProcessInvoker,
    samTaskInvoker: SamCliTaskInvoker,
    workspaceUri: vscode.Uri,
}): Promise<void> {
    try {
        // Switch over to the output channel so the user has feedback that we're getting things ready
        channelLogger.channel.show(true)

        channelLogger.info(
            'AWS.output.sam.local.start',
            'Preparing to run {0} locally...',
            localInvokeParams.handlerName
        )

        const inputTemplatePath: string = await makeInputTemplate({
            baseBuildDir,
            codeDir,
            documentUri,
            handlerName,
            runtime,
            workspaceUri,
        })
        const samTemplatePath: string = await executeSamBuild({
            baseBuildDir,
            channelLogger,
            codeDir,
            inputTemplatePath,
            manifestPath,
            samProcessInvoker,

        })

        await invokeLambdaFunction({
            baseBuildDir,
            channelLogger,
            configuration,
            debugConfig,
            samTaskInvoker,
            samTemplatePath,
            documentUri,
            handlerName,
            isDebug,
        })

    } catch (err) {
        // TODO: logger.error?
        console.log(err)
        const error = err as Error

        // TODO: Define standard/strategy. Sometimes err.message is/isn't part of msg "Error: {0}". Discuss.
        channelLogger.channel.appendLine(
            localize(
                'AWS.output.sam.local.error',
                'Error: {0}',
                error.message
            )
        )

        vscode.window.showErrorMessage(
            localize(
                'AWS.error.during.sam.local',
                'An error occurred trying to run SAM Application locally: {0}',
                error.message
            )
        )

        return
    }

}

export const makeBuildDir = async (): Promise<string> => {
    const buildDir = await makeTemporaryToolkitFolder()
    ExtensionDisposableFiles.getInstance().addFolder(buildDir)

    return buildDir
}

export async function makeInputTemplate(params: {
    baseBuildDir: string,
    // localInvokeParams: LambdaLocalInvokeParams,
    codeDir: string,
    documentUri: vscode.Uri
    handlerName: string,
    runtime: string,
    workspaceUri: vscode.Uri,
}): Promise<string> {
    const inputTemplatePath: string = path.join(params.baseBuildDir, 'input', 'input-template.yaml')

    // Make function handler relative to baseDir
    const handlerFileRelativePath = path.relative(
        params.codeDir,
        path.dirname(params.documentUri.fsPath) // localInvokeParams.document.uri.fsPath
    )

    const relativeFunctionHandler = path.join(
        handlerFileRelativePath,
        params.handlerName, // localInvokeParams.handlerName
    ).replace('\\', '/')

    // tslint:disable-next-line:max-line-length
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(params.workspaceUri) // localInvokeParams.workspaceFolder.uri
    let existingTemplateResource: CloudFormation.Resource | undefined
    if (workspaceFolder) {
        const lambdas = await detectLocalLambdas([workspaceFolder])
        const existingLambda = lambdas.find(lambda => lambda.handler === relativeFunctionHandler)
        existingTemplateResource = existingLambda ? existingLambda.resource : undefined
    }

    let newTemplate = new SamTemplateGenerator()
        .withCodeUri(params.codeDir)
        .withFunctionHandler(relativeFunctionHandler)
        .withResourceName(TEMPLATE_RESOURCE_NAME)
        .withRuntime(params.runtime)

    if (existingTemplateResource && existingTemplateResource.Properties &&
        existingTemplateResource.Properties.Environment) {
        newTemplate = newTemplate.withEnvironment(existingTemplateResource.Properties.Environment)
    }

    await newTemplate.generate(inputTemplatePath)

    return inputTemplatePath
}

export async function executeSamBuild(params: {
    baseBuildDir: string,
    channelLogger: ChannelLogger,
    codeDir: string,
    inputTemplatePath: string,
    manifestPath?: string,
    samProcessInvoker: SamCliProcessInvoker,
}): Promise<string> {
    params.channelLogger.info(
        'AWS.output.building.sam.application',
        'Building SAM Application...'
    )

    const samBuildOutputFolder = path.join(params.baseBuildDir, 'output')

    const samCliArgs: SamCliBuildInvocationArguments = {
        buildDir: samBuildOutputFolder,
        baseDir: params.codeDir,
        templatePath: params.inputTemplatePath,
        invoker: params.samProcessInvoker
    }
    if (params.manifestPath) {
        samCliArgs.manifestPath = params.manifestPath
    }
    await new SamCliBuildInvocation(samCliArgs).execute()

    params.channelLogger.info(
        'AWS.output.building.sam.application.complete',
        'Build complete.'
    )

    return path.join(samBuildOutputFolder, 'template.yaml')
}

export async function invokeLambdaFunction(params: {
    baseBuildDir: string,
    channelLogger: ChannelLogger,
    configuration: SettingsConfiguration,
    debugConfig: DebugConfiguration,
    documentUri: vscode.Uri,
    handlerName: string,
    isDebug?: boolean,
    samTemplatePath: string,
    samTaskInvoker: SamCliTaskInvoker,
    onWillAttachDebugger?(): Promise<void>,
}): Promise<void> {
    params.channelLogger.info(
        'AWS.output.starting.sam.app.locally',
        'Starting the SAM Application locally (see Terminal for output)'
    )
    params.channelLogger.logger.info(`localLambdaRunner.invokeLambdaFunction: ${JSON.stringify(
        {
            baseBuildDir: params.baseBuildDir,
            // configuration: SettingsConfiguration, // Can we pretty print this?
            debugConfig: params.debugConfig,
            documentUri: vscode.Uri,
            handlerName: params.handlerName,
            isDebug: params.isDebug,
            samTemplatePath: params.samTemplatePath,
        },
        undefined,
        2)}`
    )

    const eventPath: string = path.join(params.baseBuildDir, 'event.json')
    const environmentVariablePath = path.join(params.baseBuildDir, 'env-vars.json')
    const config = await getConfig({
        handlerName: params.handlerName,
        documentUri: params.documentUri,
    })

    await writeFile(eventPath, JSON.stringify(config.event || {}))
    await writeFile(
        environmentVariablePath,
        JSON.stringify(getEnvironmentVariables(config))
    )

    const command = new SamCliLocalInvokeInvocation({
        templateResourceName: TEMPLATE_RESOURCE_NAME,
        templatePath: params.samTemplatePath,
        eventPath,
        environmentVariablePath,
        debugPort: (params.isDebug) ? params.debugConfig.port.toString() : undefined,
        invoker: params.samTaskInvoker
    })

    await command.execute()

    if (params.isDebug) {
        params.channelLogger.info(
            'AWS.output.sam.local.waiting',
            'Waiting for SAM Application to start before attaching debugger...'
        )

        const timeoutMillis = params.configuration.readSetting<number>(
            'samcli.debug.attach.timeout.millis',
            SAM_LOCAL_PORT_CHECK_RETRY_TIMEOUT_MILLIS_DEFAULT
        )

        await tcpPortUsed.waitUntilUsed(
            params.debugConfig.port,
            SAM_LOCAL_PORT_CHECK_RETRY_INTERVAL_MILLIS,
            timeoutMillis
        )

        await attachDebugger({
            channeLogger: params.channelLogger,
            debugConfig: params.debugConfig,
            outputChannel: params.channelLogger.channel,
            onWillAttachDebugger: params.onWillAttachDebugger,
        })
    }
}

const getConfig = async (params: {
    handlerName: string
    documentUri: vscode.Uri
}): Promise<HandlerConfig> => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(params.documentUri)
    if (!workspaceFolder) {
        return buildHandlerConfig()
    }

    const config: HandlerConfig = await getLocalLambdaConfiguration(
        workspaceFolder,
        params.handlerName
    )

    return config
}

const getEnvironmentVariables = (config: HandlerConfig): SAMTemplateEnvironmentVariables => {
    if (!!config.environmentVariables) {
        return {
            [TEMPLATE_RESOURCE_NAME]: config.environmentVariables
        }
    } else {
        return {}
    }
}

export async function attachDebugger(params: {
    channeLogger: ChannelLogger,
    debugConfig: DebugConfiguration,
    outputChannel: vscode.OutputChannel,
    onWillAttachDebugger?(): Promise<void>
}) {
    const channelLogger = params.channeLogger || getChannelLogger(params.outputChannel)
    const logger = params.channeLogger.logger
    if (params.onWillAttachDebugger) {
        // Enable caller to do last minute preparation before attaching debugger
        await params.onWillAttachDebugger()
    }
    channelLogger.info(
        'AWS.output.sam.local.attaching',
        'Attaching to SAM Application...'
    )
    logger.info(`localLambdaRunner.attachDebugger: startDebugging with debugConfig: ${JSON.stringify(
        params.debugConfig,
        undefined,
        2
    )}`)
    const attachSuccess: boolean = await vscode.debug.startDebugging(undefined, params.debugConfig)

    if (attachSuccess) {
        channelLogger.info(
            'AWS.output.sam.local.attach.success',
            'Debugger attached'
        )
    } else {
        // sam local either failed, or took too long to start up
        channelLogger.error(
            'AWS.output.sam.local.attach.failure',
            // tslint:disable-next-line:max-line-length
            'Unable to attach Debugger. Check the Terminal tab for output. If it took longer than expected to successfully start, you may still attach to it.'
        )
    }
}
