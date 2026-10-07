export const JAVA_QUERY = `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(annotation_type_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.variable

(import_declaration [(scoped_identifier) (identifier)] @import.source) @import

(method_invocation object: (_)? @call.object name: (identifier) @call.callee) @call
(object_creation_expression type: (_) @call.callee) @call
`;
