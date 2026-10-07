export const PYTHON_QUERY = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(module (expression_statement (assignment left: (identifier) @name) @definition.variable))

(import_statement name: (dotted_name) @import.source) @import
(import_statement name: (aliased_import name: (dotted_name) @import.source)) @import
(import_from_statement module_name: (_) @import.source) @import

(call function: (_) @call.callee) @call
`;
