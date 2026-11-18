import { definePlugin } from '@oxlint/plugins'
import { declarationGroupSpacingRule } from './rules/declaration-group-spacing.rule.mts'
import { declarationJsdocRule } from './rules/declaration-jsdoc.rule.mts'
import { fileRoleFolderRule } from './rules/file-role-folder.rule.mts'
import { fileRoleSuffixRule } from './rules/file-role-suffix.rule.mts'
import { inferredTypePlacementRule } from './rules/inferred-type-placement.rule.mts'
import { moduleNameRule } from './rules/module-name.rule.mts'
import { noDefaultRuntimeRule } from './rules/no-default-runtime.rule.mts'
import { noInlineParamTypeRule } from './rules/no-inline-param-type.rule.mts'
import { noLetRule } from './rules/no-let.rule.mts'
import { redactedSecretConfigRule } from './rules/redacted-secret-config.rule.mts'
import { testHookSpacingRule } from './rules/test-hook-spacing.rule.mts'
import { typeParamPrefixRule } from './rules/type-param-prefix.rule.mts'

export default definePlugin({
	meta: { name: 'mng-review' },
	rules: {
		'declaration-group-spacing': declarationGroupSpacingRule,
		'declaration-jsdoc': declarationJsdocRule,
		'file-role-folder': fileRoleFolderRule,
		'file-role-suffix': fileRoleSuffixRule,
		'inferred-type-placement': inferredTypePlacementRule,
		'module-name': moduleNameRule,
		'no-default-runtime': noDefaultRuntimeRule,
		'no-inline-param-type': noInlineParamTypeRule,
		'no-let': noLetRule,
		'redacted-secret-config': redactedSecretConfigRule,
		'test-hook-spacing': testHookSpacingRule,
		'type-param-prefix': typeParamPrefixRule,
	},
})
