const FUNCTION_VALUE = "[(arrow_function) (function_expression)]";

const shared = (classNameNode: string) => `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (${classNameNode}) @name) @definition.class
(method_definition name: (_) @name) @definition.method

(program (lexical_declaration (variable_declarator name: (identifier) @name value: ${FUNCTION_VALUE}) @definition.function))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name value: ${FUNCTION_VALUE}) @definition.function)))
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))

(import_statement source: (string) @import.source) @import
((export_statement source: (string) @import.source) @import (#set! kind "reexport"))
((call_expression function: (identifier) @_fn arguments: (arguments . (string) @import.source)) @import
  (#eq? @_fn "require") (#set! kind "require"))
((call_expression function: (import) arguments: (arguments . (string) @import.source)) @import (#set! kind "dynamic"))

(export_statement) @export

(call_expression function: (_) @call.callee) @call
(new_expression constructor: (_) @call.callee) @call
`;

export const JAVASCRIPT_QUERY = shared("identifier");

export const TYPESCRIPT_QUERY = shared("type_identifier") + `
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (_) @name) @definition.module
(module name: (_) @name) @definition.module
(function_signature name: (identifier) @name) @definition.function
(abstract_method_signature name: (_) @name) @definition.method
(method_signature name: (_) @name) @definition.method
`;
