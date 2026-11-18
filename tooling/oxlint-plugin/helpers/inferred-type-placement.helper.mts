import type { ESTree } from '@oxlint/plugins'

export type ProgramStatement = ESTree.Program['body'][number]

export interface InferredAlias {
	name: string
	source: string
	sourceIndex: number
}

/** `typeof schema.Type` and `typeof schema.Encoded`. */
const SCHEMA_TYPE_PROPERTIES = new Set(['Type', 'Encoded'])
/** `Schema.Schema.Type<typeof schema>`, `Schema.Codec.Encoded<typeof schema>` and the rest, after the local name of the `Schema` import. */
const SCHEMA_INFER_HELPERS = [
	'Schema.Type',
	'Codec.Type',
	'Codec.Encoded',
	'Codec.DecodingServices',
	'Codec.EncodingServices',
] as const
const EFFECT_MODULE_PATTERN = /^effect(?:\/Schema)?$/u

function unwrapExport(statement: ProgramStatement) {
	return statement.type === 'ExportNamedDeclaration'
		? (statement.declaration ?? undefined)
		: statement
}

function getImportedName({ imported }: ESTree.ImportSpecifier) {
	return imported.type === 'Identifier' ? imported.name : imported.value
}

function getSchemaLocalNames(
	source: string,
	specifier: ESTree.ImportDeclarationSpecifier
) {
	const { name } = specifier.local

	if (source === 'effect/Schema')
		return specifier.type === 'ImportSpecifier' ? [] : [name]
	if (specifier.type === 'ImportNamespaceSpecifier') return [`${name}.Schema`]
	if (
		specifier.type === 'ImportSpecifier' &&
		getImportedName(specifier) === 'Schema'
	)
		return [name]

	return []
}

function getSchemaInferTypeNames({ body }: ESTree.Program) {
	const schemaNames = body.flatMap(statement =>
		statement.type === 'ImportDeclaration' &&
		EFFECT_MODULE_PATTERN.test(statement.source.value)
			? statement.specifiers.flatMap(specifier =>
					getSchemaLocalNames(statement.source.value, specifier)
				)
			: []
	)

	return new Set(
		schemaNames.flatMap(name =>
			SCHEMA_INFER_HELPERS.map(helper => `${name}.${helper}`)
		)
	)
}

function getTypeNameText(typeName: ESTree.TSTypeName): string | undefined {
	if (typeName.type === 'Identifier') return typeName.name
	if (typeName.type !== 'TSQualifiedName') return

	const left = getTypeNameText(typeName.left)

	return left && `${left}.${typeName.right.name}`
}

function getInferredSource(
	type: ESTree.TSType,
	schemaInferTypeNames: ReadonlySet<string>
) {
	if (type.type === 'TSTypeQuery') {
		const { exprName } = type

		return exprName.type === 'TSQualifiedName' &&
			exprName.left.type === 'Identifier' &&
			SCHEMA_TYPE_PROPERTIES.has(exprName.right.name)
			? exprName.left.name
			: undefined
	}
	if (type.type !== 'TSTypeReference') return

	const typeNameText = getTypeNameText(type.typeName)
	const [argument, ...rest] = type.typeArguments?.params ?? []

	if (
		typeNameText &&
		schemaInferTypeNames.has(typeNameText) &&
		rest.length === 0 &&
		argument?.type === 'TSTypeQuery' &&
		argument.exprName.type === 'Identifier'
	)
		return argument.exprName.name
}

function getDeclaredNames(statement: ProgramStatement) {
	const declaration = unwrapExport(statement)

	if (declaration?.type !== 'VariableDeclaration') return []

	return declaration.declarations.flatMap(declarator =>
		declarator.id.type === 'Identifier' ? [declarator.id.name] : []
	)
}

function getInferredAlias(
	statement: ProgramStatement,
	schemaInferTypeNames: ReadonlySet<string>,
	declarationIndexes: ReadonlyMap<string, number>
): InferredAlias | undefined {
	const declaration = unwrapExport(statement)

	if (declaration?.type !== 'TSTypeAliasDeclaration') return

	const source = getInferredSource(
		declaration.typeAnnotation,
		schemaInferTypeNames
	)
	const sourceIndex = source ? declarationIndexes.get(source) : undefined

	if (source && sourceIndex !== undefined)
		return { name: declaration.id.name, source, sourceIndex }
}

/**
 * Maps each module-level statement to the type alias it declares when the
 * alias is exactly `typeof schema.Type`/`typeof schema.Encoded` or an Effect
 * Schema helper of `typeof schema` (`Schema.Schema.Type`, `Schema.Codec.Encoded`
 * and the other `Codec` helpers, through any local name of the `Schema` import
 * from `effect` or `effect/Schema`) and its source is a simple identifier bound
 * by a module-level variable declaration of the same file; every other
 * statement maps to `undefined`.
 */
export function getInferredAliases(program: ESTree.Program) {
	const schemaInferTypeNames = getSchemaInferTypeNames(program)
	const declarationIndexes = new Map(
		program.body.flatMap((statement, index) =>
			getDeclaredNames(statement).map(name => [name, index] as const)
		)
	)

	return program.body.map(statement =>
		getInferredAlias(statement, schemaInferTypeNames, declarationIndexes)
	)
}
