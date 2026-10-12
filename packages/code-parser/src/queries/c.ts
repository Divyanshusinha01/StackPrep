/**
 * C-family queries capture whole declarations; `cFamilyHooks.definitions` walks the nested
 * declarator chain to name them, tells functions from variables and drops block-scope ones.
 * Spelling every declarator shape out as patterns made C++ query compilation take seconds.
 */
export const C_FAMILY_BASE_QUERY = `
(function_definition) @definition.function
(declaration) @definition.variable
(field_declaration) @definition.function
(type_definition) @definition.type
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.class
(union_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.class
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @definition.enum

(preproc_include path: (_) @import.source) @import

(call_expression function: (identifier) @call.callee) @call
(call_expression function: (field_expression argument: (_) @call.object field: (field_identifier) @call.callee)) @call
`;

export const C_QUERY = C_FAMILY_BASE_QUERY;
