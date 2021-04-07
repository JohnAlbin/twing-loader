import {getOptions, OptionObject} from 'loader-utils';
import {loader} from 'webpack';
import {
    TwingEnvironment,
    TwingLoaderArray,
    TwingLoaderChain,
    TwingLoaderInterface,
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

    let options: OptionObject;
    let resourcePath: string;
    let environmentModulePath: string;
    let renderContext: any;
    let environment: TwingEnvironment;
    let twingLoader: TwingLoaderInterface;

    try {
        options = getOptions(this);

        validateOptions(optionsSchema, options, 'Twing loader');

        resourcePath = slash(this.resourcePath);
        environmentModulePath = options.environmentModulePath;
        renderContext = options.renderContext;

        this.addDependency(slash(environmentModulePath));

        // require takes module name separated with forward slashes
        environment = require(slash(environmentModulePath));
        twingLoader = environment.getLoader();

    } catch (error) {
        callback(error);
        return;
    }

    if (renderContext === undefined) {
        const parts: string[] = [];
        let key: string;
        let sourceContext: TwingSource;
        let tokenStream: TwingTokenStream;
        let nodeModule: TwingNodeModule;
        let visitor: Visitor;

        try {
            // All parts of the exported module should be synchronous code.
            parts.push(
                `const env = require('${slash(environmentModulePath)}');`
            );

            key = getTemplateHash(resourcePath);
            sourceContext = new TwingSource(source, `${key}`);

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
            // Catch any errors in the Promise chain and return them to webpack.
            .catch(error => {
                callback(error);
                return;
            });

    } else {
        const addDependencyTasks:Promise<void>[] = [];

        try {
            environment.setLoader(new TwingLoaderChain([
                new PathSupportingArrayLoader(new Map([
                    [resourcePath, source]
                ])),
                twingLoader
            ]));
            const newLoader = environment.getLoader();

            environment.on('template', (name: string, from: TwingSource) => {
                addDependencyTasks.push(
                    newLoader.resolve(name, from)
                        .then((path) => this.addDependency(path))
                );
            });
        } catch (error) {
            callback(error);
            return;
        }

        environment
            .render(resourcePath, renderContext)
            .then(async (renderedTemplate) => {
                try {
                    await Promise.all(addDependencyTasks);
                    callback(null, `module.exports = ${JSON.stringify(renderedTemplate)};`);
                } catch (error) {
                    callback(error);
                }
                return;
            })
            .catch(error => {
                callback(error);
                return;
            });
    }
};
