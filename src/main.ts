import * as core from '@actions/core'
import * as exec from '@actions/exec'

enum INPUT_OPTIONS {
  FLAVOR = 'flavor',
  CORES = 'cores',
  MEMORY = 'mememory',
  DISK = 'disk'
}

const DEFAULT_FLAVOR = '24.04'
const DEFAULT_NUM_CORES = '6'
const DEFAULT_SIZE_MEM = '32GiB'
const DEFAULT_SIZE_DISK = '50GB'
const OPENSTACK_VM_NAME = 'openstack'

const UBUNTU_UID = '1000'
const SNAP_DAEMON_GID = '584788'
const EXEC_COMMAND_UBUNTU_USER = `lxc exec ${OPENSTACK_VM_NAME} --user ${UBUNTU_UID} --group ${SNAP_DAEMON_GID} --`
const SUNBEAM_ADMIN_CLOUD_NAME = 'sunbeam-admin'
const OPENSTACK_CLOUDS_YAML_PATH = '~/.config/openstack/clouds.yaml'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const flavor: string = core.getInput(INPUT_OPTIONS.FLAVOR) || DEFAULT_FLAVOR
    const cores: string =
      core.getInput(INPUT_OPTIONS.CORES) || DEFAULT_NUM_CORES
    const mem: string = core.getInput(INPUT_OPTIONS.MEMORY) || DEFAULT_SIZE_MEM
    const disk: string = core.getInput(INPUT_OPTIONS.DISK) || DEFAULT_SIZE_DISK
    await exec.exec('sudo lxd init', ['--auto'])
    await exec.exec(`lxc launch ubuntu:${flavor} ${OPENSTACK_VM_NAME} \
      --vm \
      -d root,size=${disk} \
      -c limits.cpu=${cores} \
      -c limits.memory=${mem}`)
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sudo snap install openstack --channel 2024.1/beta`
    )
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam prepare-node-script | bash -x`
    )
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cluster bootstrap --accept-defaults`
    )
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cloud-config -a > ${OPENSTACK_CLOUDS_YAML_PATH}`
    )
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
