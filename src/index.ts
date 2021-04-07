import {getOptions} from 'loader-utils';
import {loader} from 'webpack';
import {
    TwingEnvironment,
    TwingLoaderArray,
    TwingLoaderChain,
    TwingNodeModule,
    TwingSource, TwingTokenStream
} from 'twing';
import {Visitor} from './visitor';

const sha256 = require('crypto-js/sha256');
const hex = require('crypto-js/enc-hex');
const slash = require('slash');

const validateOptions = require('schema-utils');

const optionsSchema = {
    type: 'object',
    properties: {
        environmentModulePath: {
            type: 'string'
        },
        renderContext: {
            type: 'object'
        }
    },
    required: [
        'environmentModulePath'
    ],
    additionalProperties: false
};

class PathSupportingArrayLoader extends TwingLoaderArray {
    async getSourceContext(name: string, from: TwingSource): Promise<TwingSource> {
        const source = await super.getSourceContext(name, from);
        return new TwingSource(source.getCode(), source.getName(), name);
    }
}

export default function (this:loader.LoaderContext, source: string):string | Buffer | void | undefined {
    const callback = this.async();

    const getTemplateHash = (name: string) => {
        return this.mode !== 'production' ? name : hex.stringify(sha256(name));
    };

    const options = getOptions(this);

    validateOptions(optionsSchema, options, 'Twing loader');

    const resourcePath: string = slash(this.resourcePath);
    const environmentModulePath: string = options.environmentModulePath;
    const renderContext: any = options.renderContext;

    this.addDependency(slash(environmentModulePath));

    // require takes module name separated with forward slashes
    const environment: TwingEnvironment = require(slash(environmentModulePath));
    const twingLoader = environment.getLoader();

    if (renderContext === undefined) {
        // All parts of the exported module should be synchronous code.
        const parts: string[] = [
            `const env = require('${slash(environmentModulePath)}');`
        ];

        const key = getTemplateHash(resourcePath);
        const sourceContext: TwingSource = new TwingSource(source, `${key}`);

        let tokenStream: TwingTokenStream;
        let nodeModule: TwingNodeModule;
        let visitor: Visitor;

        try {
            tokenStream = environment.tokenize(sourceContext);
            nodeModule = environment.parse(tokenStream);
            visitor = new Visitor(twingLoader, resourcePath, getTemplateHash);
        } catch (error) {
            callback(error);
            return;
        }

        visitor
            .getTemplateNames(nodeModule)
            .then((foundTemplateNames) => {
                const precompiledTemplate = environment.compile(nodeModule);

                parts.push(`
                    const templatesModule = (() => {
                    const module = {
                        exports: undefined
                    };

                    ${precompiledTemplate}

                    return module.exports;
                    })();
                `);

                for (const foundTemplateName of foundTemplateNames) {
                    // require takes module name separated with forward slashes
                    parts.push(`require('${slash(foundTemplateName)}');`);
                }

                parts.push(
                    `env.registerTemplatesModule(templatesModule, '${key}');`
                );

                // Normally, to get the template, we'd use env.loadTemplate(),
                // which returns a Promise to get the template. But since we
                // just synchronously inserted the template with
                // registerTemplatesModule(), we can skip creating a Promise by
                // retrieving the template directly from the Twing environment's
                // loadedTemplates map.
                parts.push(`
                    const renderTemplate = (context = {}) => {
                      const name = '${key}';
                      env.emit('template', name);
                      const template = env.loadedTemplates.get(name);
                      return template.render(context);
                    };

                    module.exports = renderTemplate;
                `);

                callback(null, parts.join('\n'));
                return;
            })
            .catch(error => {
                callback(error);
                return;
            });

    } else {
        environment.setLoader(new TwingLoaderChain([
            new PathSupportingArrayLoader(new Map([
                [resourcePath, source]
            ])),
            twingLoader
        ]));
        const newLoader = environment.getLoader();

        const addDependencyTasks:Promise<void>[] = [];
        environment.on('template', (name: string, from: TwingSource) => {
            addDependencyTasks.push(
                newLoader.resolve(name, from)
                    .then((path) => this.addDependency(path))
            );
        });

        environment
            .render(resourcePath, renderContext)
            .then(async (renderedTemplate) => {
                await Promise.all(addDependencyTasks);
                callback(null, `module.exports = ${JSON.stringify(renderedTemplate)};`);
                return;
            });
    }
};
