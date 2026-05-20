.text
#if defined(__x86_64__)
.global _alloca
.global alloca
_alloca:
alloca:
pop %rdx
lea 15(%rdi), %rax
and $-16, %rax
sub %rax, %rsp
mov %rsp, %rax
push %rdx
ret
#elif defined(__aarch64__)
.align 2
.global _alloca
.global alloca
_alloca:
alloca:
.int 0x91003c00 /* add x0, x0, #15 */
.int 0x927cec00 /* and x0, x0, #0xfffffffffffffff0 */
.int 0xcb2063ff /* sub sp, sp, x0 */
.int 0x910003e0 /* mov x0, sp */
.int 0xd65f03c0 /* ret */
#endif
